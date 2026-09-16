
import { NativeRunRecordReader as Reader } from "file:///C:/Code/system-handle/packages/evidence/src/native-run-records.ts";
const e={event:"step_update",step_update:{conversation_id:"c",step_index:1,step_type:"tool",state:"DONE",tool_name:"run_command",tool_info:{parameters:{CommandLine:"pnpm test",Cwd:"C:/test"},output:"application response code: 0\nProcess still running. Command ID: cmd-1"}}};
const r=Reader.fromString(JSON.stringify(e));
console.log(JSON.stringify({id:"S14-stdout-code",verification:r.verify({tool_call_id:"step-1",command:"pnpm test",cwd:"C:/test"}),fact:r.getFact("step-1")}));
