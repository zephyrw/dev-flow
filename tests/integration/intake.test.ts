import {it,expect} from "vitest";
import {join} from "node:path";
import {setup,repository,project} from "../helpers.js";
import {git} from "../../packages/git/src/git.js";
import {IntakeSchema,intake,registerIntakeProject} from "../../packages/entry/src/intake.js";

it("unified entry discovers onboarding, reuses a conversation and keeps worktrees and new tasks distinct",async()=>{
  const s=setup(),r=await repository(s.root);
  try {
    const request=IntakeSchema.parse({working_directory:r.repo,title:"修复筛选",request:"用 DevFlow 帮我修复筛选",conversation_id:"conversation-a",complexity:"simple",workspace_mode:"existing_workspace",idempotency_key:"request-a"});
    expect((await intake(s.engine,request)).next_action).toBe("onboard");
    await registerIntakeProject(s.engine,{working_directory:r.repo,project:project(r.repo),browser_recipes:[]});
    const first=await intake(s.engine,request);
    expect(first.next_action).toBe("plan");
    expect(first.workflow).toBeDefined();
    expect((await intake(s.engine,request)).workflow?.id).toBe(first.workflow!.id);
    expect((await intake(s.engine,{...request,intent:"continue",idempotency_key:"resume-a"})).workflow?.id).toBe(first.workflow!.id);
    const otherRoot=join(s.root,"another-checkout");
    await git(r.repo,["worktree","add","-b","task/other",otherRoot]);
    const second=await intake(s.engine,{...request,working_directory:otherRoot,idempotency_key:"request-b"});
    expect(second.workflow?.id).not.toBe(first.workflow!.id);
    expect(second.context).toMatchObject({working_directory:otherRoot,roots:{main:otherRoot}});
    expect((await intake(s.engine,{...request,intent:"new",idempotency_key:"new-a"})).workflow?.id).not.toBe(first.workflow!.id);
    expect((await intake(s.engine,{...request,conversation_id:"unbound",intent:"continue"})).next_action).toBe("select_workflow");
    expect(s.store.list("process_record")).toHaveLength(0);
  } finally {s.store.close()}
},60000);
