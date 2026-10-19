from pathlib import Path
import io,json,wave,subprocess
import numpy as np
from scipy import signal
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT.parent
SKILL=Path(r'C:/Users/yckj4798/.codex/skills/video-shotcraft')
FF=SKILL/'workbench/node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.484/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe'
raw=subprocess.check_output([str(FF),'-v','error','-i',str(SKILL/'assets/audio/bgm/house-vibez.mp3'),'-t','110','-f','wav','-c:a','pcm_s16le','-ac','1','-ar','22050','-'])
with wave.open(io.BytesIO(raw)) as f:y=np.frombuffer(f.readframes(f.getnframes()),np.int16).astype(float)/32768
low=signal.sosfilt(signal.butter(4,[40,160],fs=22050,btype='band',output='sos'),y)
env=np.sqrt(np.mean(np.pad(low**2,(0,(-len(low))%110)).reshape(-1,110),axis=1))
peaks,_=signal.find_peaks(env,distance=int(.30*22050/110),prominence=np.quantile(env,.55)*.3)
times=peaks*110/22050
high=signal.sosfilt(signal.butter(4,[4000,9500],fs=22050,btype='band',output='sos'),y)
henv=np.sqrt(np.mean(np.pad(high**2,(0,(-len(high))%110)).reshape(-1,110),axis=1))
hpeaks,_=signal.find_peaks(henv,distance=int(.20*22050/110),prominence=np.quantile(henv,.55)*.3)
htimes=hpeaks*110/22050
timing=json.loads((ROOT/'src/audio-timing.json').read_text(encoding='utf-8'))
cuts=[]
for frame in sorted(set(timing['shot_frames'][:-1]+[round(b*timing['period']*30) for b in [24,60,68,80,92,104,112,124]])):
 target=timing['source_start']+frame/30
 breakdown=57.2<target<61
 candidates=htimes if breakdown else times
 beat=float(candidates[np.argmin(abs(candidates-target))]);cuts.append({'frame':frame,'nearest_transient_seconds':beat,'transient_band':'hihat 4–9.5 kHz (bass-free breakdown)' if breakdown else 'bass 40–160 Hz','error_frames':(target-beat)*30})
report={'method':'Measured percussion RMS peaks, 5 ms hop; bass for main sections, hihat during the source track bass-free breakdown at 57.2–61 seconds. Outro shifted 1 frame toward its measured bass transient.','cuts':cuts,'max_abs_frames':max(abs(c['error_frames']) for c in cuts),'within_3_frames':all(abs(c['error_frames'])<=3 for c in cuts),'non_grid_motion_events':[{'frame':timing['shot_frames'][6]+148,'event':'account replacement wipe','alignment':'dedicated switch SFX peak, not a major shot cut'}]}
(OUT/'music-beat-check.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
