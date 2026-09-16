"""Generate traceable delivery inventory and refresh existing progress documents."""
from pathlib import Path
import hashlib, json, re, shutil
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[1]
status_file = root / 'docs/test/验证清单.json'
if status_file.exists() and json.loads(status_file.read_text(encoding='utf-8')).get('status') == 'testing_paused_by_user':
 raise SystemExit('用户已暂停测试：禁止将旧测试结果重新绑定到当前源码。恢复测试并取得当前版本证据后再更新交付清单。')
report=json.loads((root/'.cache/test-report.json').read_text(encoding='utf-8-sig'))
e2e=json.loads((root/'.cache/e2e-report.json').read_text(encoding='utf-8-sig'))
assert report['numFailedTests']==0 and report['numPendingTests']==0, 'Do not publish failed or skipped automated checks as delivery evidence'
assert e2e['stats']['unexpected']==0 and e2e['stats']['skipped']==0 and e2e['stats']['expected']>=2, 'E2E delivery gate failed'
out = root / 'docs/test/evidence'
out.mkdir(parents=True, exist_ok=True)
copies = {
 '.cache/test-report.json':'test-report.json',
 '.cache/e2e-report.json':'e2e-report.json',
 '.cache/pnpm-audit.json':'pnpm-audit.json',
 '.cache/doctor.json':'doctor.json',
 '.cache/installed-mcp-check.json':'installed-mcp-check.json',
 '.cache/installed-config-check.json':'installed-config-check.json',
 '.cache/e2e-plan.png':'ui-plan.png',
 '.cache/e2e-complete.png':'ui-complete.png',
 '.cache/live-agy/workflow-1789117518020/summary.json':'agy/summary.json',
 '.cache/live-agy/workflow-1789117518020/stdout.jsonl':'agy/stdout.jsonl',
 '.cache/live-agy/workflow-1789117518020/live-logs.png':'agy/live-logs.png',
 '.cache/live-agy/resume-stop/summary.json':'agy/resume-stop.json',
 '.cache/live-opentabs/parallel-1789113387057/summary.json':'opentabs/parallel.json',
 '.cache/live-opentabs/gateway.json':'opentabs/gateway.json',
 '.cache/live-opentabs/real-browser.png':'opentabs/browser.png',
 '.cache/live-codex/review-1789116707467/summary.json':'codex/summary.json',
 '.cache/live-codex/review-1789116707467/review.json':'codex/review.json',
 '.cache/live-codex/review-1789116707467/events.json':'codex/events.json',
}
for source, target in copies.items():
    destination=out/target; destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(root/source,destination)
agy=json.loads((root/'.cache/live-agy/workflow-1789117518020/summary.json').read_text(encoding='utf-8'))
for evidence in agy['evidence']:
    for i,item in enumerate(evidence['files']):
        source=Path(item['path']);target=out/'agy'/f"{evidence['test_id']}-{i}{source.suffix}"
        assert hashlib.sha256(source.read_bytes()).hexdigest()==item['hash']
        shutil.copyfile(source,target)
for source in (root/'.cache/live-opentabs/parallel-1789113387057').glob('wf-*.json'):
    shutil.copyfile(source,out/'opentabs'/source.name)

def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()
files=[]
for directory in ['apps','packages','host','scripts','tests','examples','config']:
    for file in (root/directory).rglob('*'):
        if file.is_file() and not any(p in {'bin','obj','__pycache__'} for p in file.relative_to(root).parts):
            files.append({'path':file.relative_to(root).as_posix(),'sha256':digest(file)})
for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.build.json','vitest.config.ts','playwright.config.ts','.gitignore','.gitattributes','.npmrc']:
    files.append({'path':name,'sha256':digest(root/name)})
files.sort(key=lambda f:f['path'])
report=json.loads((root/'.cache/test-report.json').read_text(encoding='utf-8-sig'))
e2e=json.loads((root/'.cache/e2e-report.json').read_text(encoding='utf-8-sig'))
core_count=report['numTotalTests']
manifest={
 'created_at':datetime.now(timezone.utc).isoformat(),
 'source_sha256':hashlib.sha256(json.dumps(files,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),
 'source_files':files,
 'tests':{key:report[key] for key in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests']},
 'test_runs':[{'report':'evidence/test-report.json','tests':core_count}],
 'e2e':e2e.get('stats'),
 'real_agy':{'state':agy['state'],'marker_visible':agy['ui_logs_contain_marker'],'tool_logs_visible':agy['ui_logs_contain_tool']},
 'actual_user_acceptance':False,'managed_windows_install_verified':False,
 'source_review':'docs/test/源码独立复核记录.md',
 'evidence':[{'path':f.relative_to(root).as_posix(),'sha256':digest(f)} for f in sorted(out.rglob('*')) if f.is_file()]
}
(root/'docs/test/验证清单.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

progress=root/'docs/process/DevFlow工作流开发进度.md'
old=progress.read_text(encoding='utf-8')
rows=[]
verified={19}
special={1:'工具调用已核实；受管身份能力待安装探针',9:'受控路径已实现和测试；原生权限探针未完成',10:'受控补丁已验证；完整 Windows 隔离联合验收未完成',15:'数据隔离已验证；专用账户 ACL 和登录未完成',16:'当前身份的 Host/进程树/UTF-8 已验证；身份切换待安装验证',21:'真实测试运行和失败修复已验证；专用身份联合验证未完成',25:'真实浏览器场景已验证；用户实操接管待验收',26:'中文概览和任务页面已验证；完整并行 UI 合同待专项验收',27:'真实过程日志/刷新续看已验证；完整历史日志专项验收待完成',28:'批准/反馈/验收 UI 已验证；全部停止与故障 UI 合同未完成',31:'修复计划逻辑已实现；实际缺陷复核修复闭环待专项验收',34:'named Job/互斥/恢复已验证；完整系统重启验收未完成',35:'错误分类与事件通知已实现；全部故障注入未完成',37:'安装脚本、配置和指南已完成；未执行系统安装',38:'确定性 E2E 和关键并发测试通过；全部复合 E2E 合同未完成',39:'真实 OpenTabs 三环境验收通过；完整控制台场景待用户验收',40:'真实 agy/GPT-6 接入通过；用户实际验收及正式安装闭环未完成'}
for line in old.splitlines():
    cols=[v.strip() for v in line.split('|')]
    if len(cols)>=9 and re.fullmatch(r'T-\d{2}',cols[2]):
        number=int(cols[2][2:]);status='验证通过' if number in verified else special.get(number,'已实现，核心路径验证通过；完整专项合同待验收')
        evidence='[验证清单](../test/验证清单.json)；[联调报告](../test/实施与联调报告.md)'
        rows.append(f"| [{'x' if number in verified else ' '}] | {cols[2]} | {cols[3]} | {cols[4]} | {status} | {cols[6]} | {evidence} |")
assert len(rows)==40
progress.write_text('''# DevFlow 工作流开发进度

版本：实施记录 1.0 · 2026-09-11。用户已授权完整实施；本次由 Codex 在当前目录开发，真实 Gemini 调用用于联调。

源码已落地。勾选仅表示下列任务已有相应可核对证据，不表示原计划的全部生产安装和用户验收已完成。未完成的复合验收明确保留未勾选，禁止由模型填写用户验收通过。

此处严格按原计划的全部完成条件结案；功能已实现、核心路径通过，但完整复合验收尚未逐项覆盖的任务也保留未勾选。自动测试通过数量另见验证清单。

## 当前结果

本地服务、MCP、5 个 Skill、中文界面、Windows Host、多工作区/端口/数据、真实模型与 OpenTabs 适配、测试门禁、独立复核、精确提交和恢复已实现。使用入口见 [使用指南](../guide/使用与恢复指南.md)。接口经实际联调修订，见 [实施对应](../design/实施接口与原计划对应.md)。

## 任务清单

| 完成 | 编号 | 任务 | 依赖 | 状态 | 必需验证 | 当前证据 |
|---|---|---|---|---|---|---|
'''+ '\n'.join(rows)+'''

## 尚需完成的部署和验收

- [ ] 管理员执行专用 Windows 身份安装，完成实际身份登录与全部隔离探针。
- [ ] 用户本人完成真实页面操作、共享浏览器接管与三任务并行体验。
- [ ] 完成原计划尚未覆盖的全部复合故障/UI 验收合同。
- [x] 按用户要求在首次本地提交前完成 DevFlow 源码独立复核、局部修复及回归，见 [源码复核记录](../test/源码独立复核记录.md)。
- [ ] 正式安装后的真实用户验收与模型提交闭环。

真实模型和浏览器的临时演示仓库记录与 DevFlow 源码的首次本地 Git 提交分别留证；未推送或发布。当前源码指纹、自动化数量和原始证据 hash 保存在验证清单中。
''',encoding='utf-8')

testfile=root/'docs/test/DevFlow工作流测试计划与进度.md'
text=testfile.read_text(encoding='utf-8')
full={'UT-05','UT-13','UT-16','UT-17','IT-08','IT-09','IT-14','E2E-01','BROWSER-04'}
pending={'IT-04','IT-17','HUMAN-01','HUMAN-02','HUMAN-03'}
def state(key):
    if key in full:return '已验证；见原始证据和验证清单'
    if key in pending:return '未完成实际安装/用户验收；保持未勾选'
    return '已有核心路径证据；完整复合合同未完成'
lines=[];current=None
for line in text.splitlines():
    if line.startswith(('这是拟实施的测试合同','原计划的 57 个复合验收项保留。')):
        line=f"原计划的 57 个复合验收项保留。当前自动测试 {report['numPassedTests']}/{report['numTotalTests']} 通过，E2E 结果见验证清单；真实 agy、GPT-6 和 OpenTabs 证据单独保存。专用 Windows 安装及用户本人验收尚未完成，不能据自动测试函数数量宣称全部合同通过。"
    if line.startswith('下列操作须在对应任务实现后执行。'):line='下列步骤为原始验收合同；当前结果按每节末尾更新。部分验证不等于全部前置和专项场景已经完成。'
    m=re.match(r'### ((?:UT|IT|E2E|BROWSER|HUMAN)-\d+)',line)
    if m:current=m.group(1)
    cols=[v.strip() for v in line.split('|')]
    if len(cols)>=8 and re.fullmatch(r'(UT|IT|E2E|BROWSER|HUMAN)-\d+',cols[2]):
        key=cols[2];line=f"| [{'x' if key in full else ' '}] | {key} | {cols[3]} | {cols[4]} | {cols[5]} | {state(key)} |"
    if line.startswith('- 当前状态：') and current:line=f'- 当前状态：{state(current)}；证据：[验证清单](验证清单.json)、[实施与联调报告](实施与联调报告.md)。'
    if line.startswith('测试编排命令由 T-02/T-21 实现后固定为'):line='测试脚本已实现：pnpm run test:unit、pnpm run test:integration、pnpm run test:e2e；真实调用由 tests/live/ 中的独立测试入口执行。原始报告已复制到 docs/test/evidence 以便随交付保存。'
    lines.append(line)
testfile.write_text('\n'.join(lines)+'\n',encoding='utf-8')
print(json.dumps({'tests':manifest['tests'],'e2e':manifest['e2e'],'source_sha256':manifest['source_sha256']},ensure_ascii=False))
