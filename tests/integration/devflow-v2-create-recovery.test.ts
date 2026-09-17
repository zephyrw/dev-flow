import {it,expect} from "vitest";
import {setup,repository} from "../helpers.js";
import {CreateWorkflowService} from "../../packages/core/src/create-workflow.js";
import {existsSync} from "node:fs";
it("Git 工作树已创建而数据库事务失败时重试复用原工作树和分支",async()=>{
 const s=setup(),repo=await repository(s.root),service=new CreateWorkflowService(s.store);
 const input={request_id:"interrupted-create",workspace_root:repo.repo,request_text:"完整需求",planner_profile_id:"profile-codex"};
 const transaction=s.store.transaction.bind(s.store);
 try{
  s.store.transaction=()=>{throw Error("simulated database interruption");};
  expect(()=>service.execute(input)).toThrow("simulated database interruption");
  const pending=s.store.list<any>("workspace_creation")[0];expect(existsSync(pending.workspace.root)).toBe(true);expect(s.store.list("workflow")).toHaveLength(0);
  s.store.transaction=transaction;
  const result=service.execute(input);expect(result.workflow.id).toBe(pending.workflow.id);
  expect(s.store.list<any>("workspace")[0].root).toBe(pending.workspace.root);
  expect(s.store.list("workspace_creation")).toHaveLength(0);expect(s.store.list("run")).toHaveLength(0);
  expect(service.execute(input).workflow.id).toBe(result.workflow.id);
  expect(()=>service.execute({...input,request_text:"changed"})).toThrow("相同请求");
 }finally{s.store.transaction=transaction;s.store.close();}
});
