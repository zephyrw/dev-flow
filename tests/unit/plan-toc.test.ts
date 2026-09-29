// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { compilePlanDocument, extractToc, slugifyHeading } from "../../apps/web/src/plan-document.js";

describe("plan-toc (U2: 大纲标题与锚点跳转)", () => {
  it("无标题或空文档返回空数组", () => {
    expect(extractToc("")).toEqual([]);
    expect(extractToc("这里只是一段纯正文，没有任何 Markdown 标题。")).toEqual([]);
  });

  it("提取多层级标题 (h1 到 h4) 并正确记录 level", () => {
    const md = `
# 标题一
一些段落
## 二级标题 A
### 三级标题 A.1
#### 四级标题 A.1.1
## 二级标题 B
`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(5);
    expect(toc[0]).toEqual({
      id: encodeURIComponent("标题一"),
      text: "标题一",
      level: 1,
    });
    expect(toc[1]).toEqual({
      id: encodeURIComponent("二级标题-a"),
      text: "二级标题 A",
      level: 2,
    });
    expect(toc[2]).toEqual({
      id: encodeURIComponent("三级标题-a1"),
      text: "三级标题 A.1",
      level: 3,
    });
    expect(toc[3]).toEqual({
      id: encodeURIComponent("四级标题-a11"),
      text: "四级标题 A.1.1",
      level: 4,
    });
    expect(toc[4]).toEqual({
      id: encodeURIComponent("二级标题-b"),
      text: "二级标题 B",
      level: 2,
    });
  });

  it("正确剥除 Markdown 格式化符号和链接 URL 并保留纯净文字", () => {
    const md = `
## **加粗标题** 与 *斜体* 和 \`Inline Code\`
### [链接标题](http://example.com)
`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(2);
    expect(toc[0]?.text).toBe("加粗标题 与 斜体 和 Inline Code");
    expect(toc[1]?.text).toBe("链接标题");
    expect(toc[1]?.id).toBe(encodeURIComponent("链接标题"));
  });

  it("忽略代码块围栏中的假标题", () => {
    const md = `
# 正式标题一
\`\`\`bash
# 这是代码注释
## 代码内假标题
\`\`\`
## 正式标题二
`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(2);
    expect(toc[0]?.text).toBe("正式标题一");
    expect(toc[1]?.text).toBe("正式标题二");
  });

  it("对重复标题及包含自然后缀的标题生成无碰撞唯一ID (A, A, A-1)", () => {
    const md = `
## A
## A
## A-1
`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(3);
    expect(toc[0]?.id).toBe("a");
    expect(toc[1]?.id).toBe("a-1");
    expect(toc[2]?.id).toBe("a-1-1"); // a-1 已被占用，自动递增为 a-1-1，无冲突！
  });

  it("对超长标题正常提取且不抛出异常", () => {
    const longTitle = "这是一个非常非常长的大纲标题".repeat(20);
    const md = `## ${longTitle}\n正文内容`;
    const toc = extractToc(md);
    expect(toc).toHaveLength(1);
    expect(toc[0]?.text).toBe(longTitle);
    expect(toc[0]?.id).toBeTruthy();
  });

  it("slugifyHeading 稳健处理纯特殊符号和空字符", () => {
    expect(slugifyHeading("   ")).toBe("section");
    expect(slugifyHeading("!@#$%^&*()")).toBe("section");
    expect(slugifyHeading("Hello World")).toBe("hello-world");
    expect(slugifyHeading("中文 模块")).toBe(encodeURIComponent("中文-模块"));
  });

  it("Setext 与 ATX 标题的目录文字和锚点共享实际渲染节点", () => {
    const compiled = compilePlanDocument("Intro\n=====\n\n## Next\n\nSubtitle\n--------\n");
    expect(compiled.toc).toEqual([
      { id: "intro", text: "Intro", level: 1 },
      { id: "next", text: "Next", level: 2 },
      { id: "subtitle", text: "Subtitle", level: 2 },
    ]);
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(compiled.content);
    expect(Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).map((heading) => ({
      id: heading.id,
      text: heading.textContent,
      level: Number(heading.tagName.slice(1)),
    }))).toEqual(compiled.toc);
  });

  it("真实 Markdown 语法处理引用标题、链接引用、实体、转义和混合代码围栏", () => {
    const compiled = compilePlanDocument([
      "> ## [A &amp; B][target] and \\*literal\\* ##",
      "",
      "[target]: https://example.com/reference",
      "",
      "````md",
      "```",
      "# hidden in longer fence",
      "````",
      "",
      "    # indented code",
      "",
      "## Visible",
    ].join("\n"));
    expect(compiled.toc.map((item) => item.text)).toEqual(["A & B and *literal*", "Visible"]);
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(compiled.content);
    for (const item of compiled.toc) {
      expect(Array.from(container.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).filter((heading) => heading.id === item.id))
        .toHaveLength(1);
    }
  });

  it("重复标题及自然后缀在正文和大纲中唯一，重复编译和渲染不消耗索引", () => {
    const markdown = "## A\n## A\n## A-1\n## A\n## A-1\n";
    const compiled = compilePlanDocument(markdown);
    const first = renderToStaticMarkup(compiled.content);
    expect(renderToStaticMarkup(compiled.content)).toBe(first);
    expect(renderToStaticMarkup(compilePlanDocument(markdown).content)).toBe(first);
    const container = document.createElement("div");
    container.innerHTML = first;
    const ids = Array.from(container.querySelectorAll<HTMLElement>("h2")).map((heading) => heading.id);
    expect(ids).toEqual(compiled.toc.map((item) => item.id));
    expect(ids).toEqual(["a", "a-1", "a-1-1", "a-2", "a-1-2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("GFM 生成的脚注标签保留辅助功能 ID 且不变成计划目录项", () => {
    const compiled = compilePlanDocument("# Footnote label\n\nBody[^note].\n\n[^note]: Footnote text\n");
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(compiled.content);
    expect(compiled.toc).toHaveLength(1);
    expect(compiled.toc[0]?.id).toBe("footnote-label-1");
    expect(container.querySelector(".footnotes h2")?.id).toBe("footnote-label");
    expect(container.querySelector("[data-footnote-ref]")?.getAttribute("aria-describedby"))
      .toBe("footnote-label");
  });
});
