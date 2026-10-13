// Evidence-only provider: deterministic tool calls through the real Pi agent loop.
// No network model requests. A tool_call delay exposes read running UI without changing tools/renderers.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const session = 'personal-servers/yocto-builder';
const localPath = 'evidence/tool-output-visibility/sample.txt';
export default function(pi: ExtensionAPI) {
 pi.on('tool_call', async event => {
  if (event.toolName === 'read') await new Promise(resolve => setTimeout(resolve, 4000));
 });
 pi.registerProvider('visibility-fixture', {
  baseUrl:'http://fixture.invalid', apiKey:'fixture-not-a-secret', api:'openai-completions',
  models:[{id:'deterministic', name:'Evidence fixture', reasoning:false, input:['text'], cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096}],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const messages = context.messages;
    const userIndex = messages.findLastIndex(m => m.role === 'user');
    const user = messages[userIndex];
    const scenario = typeof user?.content === 'string' ? user.content.trim() : (user?.content as any[])?.filter(p=>p.type==='text').map(p=>p.text).join('').trim();
    const finished = messages.slice(userIndex + 1).filter(m=>m.role==='toolResult').length;
    const remote = scenario?.startsWith('remote-');
    const route = remote ? {session} : {};
    const calls: Record<string, Array<{name:string,arguments:any}>> = {
     'local-read':[{name:'read',arguments:{path:localPath}}],
     'remote-read':[{name:'read',arguments:{path:'/etc/os-release',...route}}],
     'local-read-error':[{name:'read',arguments:{path:'evidence/tool-output-visibility/does-not-exist'}}],
     'remote-read-error':[{name:'read',arguments:{path:'/pi-visibility-fixture-does-not-exist',...route}}],
     'local-bash':[{name:'bash',arguments:{command:"printf 'RUNNING fixture\\n'; sleep 6; printf '"+Array.from({length:40},(_,i)=>`LINE-${String(i+1).padStart(2,'0')}\\n`).join('')+"'"}}],
     'remote-bash':[{name:'bash',arguments:{command:"printf 'RUNNING fixture\\n'; sleep 6; printf 'REMOTE fixture complete\\n'",timeout:25,connect_timeout:10,...route}}],
     'local-bash-error':[{name:'bash',arguments:{command:"printf 'fixture intentional error\\n' >&2; exit 7"}}],
     'remote-bash-error':[{name:'bash',arguments:{command:"printf 'fixture intentional error\\n' >&2; exit 7",timeout:25,connect_timeout:10,...route}}],
     'consecutive':[{name:'read',arguments:{path:localPath}},{name:'read',arguments:{path:localPath,offset:2,limit:2}},{name:'ls',arguments:{path:'src'}},{name:'grep',arguments:{path:localPath,pattern:'ALPHA'}},{name:'find',arguments:{path:'src',pattern:'index.ts'}}],
    };
    const next = calls[scenario]?.[finished];
    const content:any[] = next ? [{type:'toolCall',id:`fixture-${scenario}-${finished}`, ...next}] : [{type:'text',text:`FIXTURE COMPLETE ${scenario}`}];
    const message:any = {role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:next?'toolUse':'stop',timestamp:Date.now()};
    stream.push({type:'start',partial:message});
    if(next) stream.push({type:'toolcall_end',contentIndex:0,toolCall:content[0],partial:message});
    else stream.push({type:'text_end',contentIndex:0,content:content[0].text,partial:message});
    stream.push({type:'done',reason:message.stopReason,message});
   });
   return stream;
  }
 });
}
