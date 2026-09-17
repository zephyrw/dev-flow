import {it,expect} from "vitest";
import {setup} from "../helpers.js";
for(const state of ["COMPLETED","CLEANUP_PENDING"])it(state+" 不被迟到异常或暂停覆盖",async()=>{
 const s=setup(),id="terminal-state";try{
  s.store.put("workflow",id,"project",{id,project_id:"project",state,stage:"cleanup",version:7});
  s.engine.block(id,Error("late callback"));expect(s.engine.get(id).state).toBe(state);
  await expect(s.engine.stop(id)).rejects.toMatchObject({code:"INVALID_STATE"});
  expect(s.engine.get(id).version).toBe(7);
 }finally{s.store.close();}
});
