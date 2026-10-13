#!/usr/bin/env python3
"""Run real interactive Pi in detached tmux; save rendered text and ANSI frames.
Usage: python3 evidence/tool-output-visibility/capture.py before|after [width]
No model network requests; only the authorized remote session receives read-only calls.
"""
import subprocess, pathlib, sys, time, shlex, hashlib, json
root = pathlib.Path(__file__).resolve().parents[2]
phase = sys.argv[1]
assert phase in ('before','after')
width = int(sys.argv[2]) if len(sys.argv)>2 else 100
height = 38
base = root/'evidence/tool-output-visibility'
out = base/phase/(f'{width}x{height}')
out.mkdir(parents=True,exist_ok=True)
source = base/'baseline-source/index.ts' if phase=='before' else root/'src/index.ts'
server = f'pi-visibility-{phase}-{width}'
def tmux(*args):
 return subprocess.run(['tmux','-L',server,*args],capture_output=True,text=True,check=True).stdout
try: tmux('has-session','-t','capture-keeper')
except subprocess.CalledProcessError:
 tmux('new-session','-d','-s','capture-keeper','-x',str(width),'-y',str(height),'/bin/sh')
tmux('set-option','-g','remain-on-exit','on')
cmd = ['env','-u','PI_PACKAGE_DIR','-u','FO_CODING_AGENT_DIR',str(pathlib.Path.home()/'.bun/bin/pi'),'--no-extensions','-e',str(source),'-e',str(base/'fixture.ts'),'--provider','visibility-fixture','--model','deterministic','--no-session','--no-mcp','--offline','--no-skills','--no-prompt-templates','--no-context-files']
metadata = {'phase':phase,'viewport':[width,height],'hostVersion':subprocess.check_output(['env','-u','PI_PACKAGE_DIR','-u','FO_CODING_AGENT_DIR',str(pathlib.Path.home()/'.bun/bin/pi'),'--version'],text=True).strip(),'command':shlex.join(cmd),'sourceHashes':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source.parent.glob('*.ts')}}
(out/'manifest.json').write_text(json.dumps(metadata,indent=2)+'\n')
def frame(target,name):
 for ansi,suffix in [(False,'txt'),(True,'ansi')]:
  args=['capture-pane','-p','-t',target]
  if ansi: args.append('-e')
  (out/f'{name}.{suffix}').write_text(tmux(*args))
scenarios=sys.argv[3].split(',') if len(sys.argv)>3 else ['local-read','remote-read','local-read-error','remote-read-error','local-bash','remote-bash','local-bash-error','remote-bash-error','consecutive']
try:
 for scenario in scenarios:
  target=f'{phase}-{width}-{scenario}'
  launch='cd '+shlex.quote(str(root))+' && '+shlex.join(cmd)
  tmux('new-session','-d','-s',target,'-x',str(width),'-y',str(height),launch)
  start=time.monotonic()
  while True:
   screen=tmux('capture-pane','-p','-t',target)
   if 'Evidence fixture' in screen or 'deterministic' in screen: break
   if 'Failed to load extension' in screen or time.monotonic()-start>25:
    frame(target,scenario+'-startup-failure'); raise RuntimeError('startup failed: '+scenario)
   time.sleep(.15)
  tmux('send-keys','-t',target,'-l',scenario); tmux('send-keys','-t',target,'Enter')
  if scenario in ['local-read','remote-read','local-bash','remote-bash']:
   time.sleep(1.2); frame(target,scenario+'-running-collapsed')
   tmux('send-keys','-t',target,'C-o'); time.sleep(.3); frame(target,scenario+'-running-expanded')
   tmux('send-keys','-t',target,'C-o')
  start=time.monotonic()
  while True:
   screen=tmux('capture-pane','-p','-t',target)
   if 'FIXTURE COMPLETE '+scenario in screen: break
   if time.monotonic()-start>65:
    frame(target,scenario+'-timeout'); raise RuntimeError('tool completion timeout: '+scenario)
   time.sleep(.2)
  frame(target,scenario+'-collapsed')
  tmux('send-keys','-t',target,'C-o'); time.sleep(.3); frame(target,scenario+'-expanded')
  tmux('send-keys','-t',target,'C-o'); time.sleep(.3); frame(target,scenario+'-recollapsed')
  print(f'{phase} {width}: {scenario} captured',flush=True)
  tmux('kill-session','-t',target)
finally:
 tmux('kill-session','-t','capture-keeper')
