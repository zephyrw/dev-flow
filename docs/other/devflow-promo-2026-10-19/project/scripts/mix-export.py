"""Mix the same exported SHOTS/SFX/BGM manifest, then copy one picture stream into two MP4s."""
from pathlib import Path
import json, wave, subprocess, argparse
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT.parent
parser=argparse.ArgumentParser()
parser.add_argument('--output-dir')
args=parser.parse_args()
DEST=Path(args.output_dir).resolve() if args.output_dir else OUT
DEST.mkdir(parents=True,exist_ok=True)
MAN=json.loads((ROOT/'export-timeline.json').read_text(encoding='utf-8'))
BIN=Path(r'C:/Users/yckj4798/.codex/skills/video-shotcraft/workbench/node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.484/node_modules/@remotion/compositor-win32-x64-msvc')
SR=48000; N=round(MAN['total']/MAN['fps']*SR)
def read(p):
    with wave.open(str(p)) as f:
        assert f.getframerate()==SR and f.getnchannels()==2
        return np.frombuffer(f.readframes(f.getnframes()),np.int16).reshape(-1,2).astype(np.float64)/32768
def add(mix,clip):
    a=read(ROOT/'public'/clip['src']);at=round(clip['from']/MAN['fps']*SR)
    end=min(N,at+len(a),at+round(clip['duration']/MAN['fps']*SR))
    mix[at:end]+=a[:end-at]*clip['volume']
def write(p,a):
    with wave.open(str(p),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR);f.writeframes(np.rint(a*32767).clip(-32768,32767).astype(np.int16).tobytes())
sfx=np.zeros((N,2),np.float64)
for clip in MAN['sfx']:add(sfx,clip)
full=sfx.copy()
for clip in MAN['bgm']:add(full,clip)
report={}
for name,data in [('no-bgm',sfx),('music',full)]:
    peak=float(np.max(np.abs(data)));assert peak<.99, f'Clipping: {name} {peak}'
    target=OUT/'.tmp'/f'{name}.wav';write(target,data)
    report[name]={'peak_dbfs':float(20*np.log10(peak+1e-12)),'duration':N/SR}
    subprocess.run([str(BIN/'ffmpeg.exe'),'-hide_banner','-v','error','-y','-i',str(OUT/'.tmp/picture-master.mp4'),'-i',str(target),'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','256k','-movflags','+faststart','-t',str(N/SR),str(DEST/f'DevFlow-{name}-1080p.mp4')],check=True)
(DEST/'audio-export-check.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
