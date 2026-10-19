"""Analyze local licensed assets in memory; produce the soundtrack and timing metadata."""
from pathlib import Path
import json, subprocess, os, io, wave
import numpy as np
from scipy import signal
ROOT=Path(__file__).resolve().parents[1]
SKILL=Path(os.environ.get('VIDEO_SHOTCRAFT_HOME',r'C:/Users/yckj4798/.codex/skills/video-shotcraft'))
BIN=SKILL/'workbench/node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.484/node_modules/@remotion/compositor-win32-x64-msvc'
FFMPEG=str(BIN/'ffmpeg.exe')
OUT=ROOT/'public/audio';OUT.mkdir(parents=True,exist_ok=True)
TMP=ROOT.parent/'.tmp';TMP.mkdir(exist_ok=True)
SR=22050
def decode(p,limit=None):
    cmd=[FFMPEG,'-v','error','-i',str(p)]
    if limit:cmd+=['-t',str(limit)]
    cmd+=['-f','wav','-c:a','pcm_s16le','-ac','1','-ar',str(SR),'-']
    with wave.open(io.BytesIO(subprocess.check_output(cmd))) as f:
        return np.frombuffer(f.readframes(f.getnframes()),np.int16).astype(np.float32)/32768
music=SKILL/'assets/audio/bgm/house-vibez.mp3'
y=decode(music,85)
low=signal.sosfilt(signal.butter(4,[40,160],fs=SR,btype='band',output='sos'),y)
hop=110
env=np.sqrt(np.mean(np.pad(low**2,(0,(-len(low))%hop)).reshape(-1,hop),axis=1))
peaks,_=signal.find_peaks(env,distance=int(.30*SR/hop),prominence=np.quantile(env,.55)*.3)
times=peaks*hop/SR;weights=env[peaks]
valid=(times>1)&(times<78);times=times[valid];weights=weights[valid]
candidates=[]
for bpm in np.linspace(120,126,1201):
    period=60/bpm
    phase=np.exp(2j*np.pi*times/period)
    z=np.sum(weights*phase)/np.sum(weights)
    candidates.append((abs(z),bpm,float(np.angle(z)%(2*np.pi))*period/(2*np.pi)))
score,bpm,phase=max(candidates)
period=60/bpm
indices=np.rint((times-phase)/period)
res=times-(phase+indices*period)
good=np.abs(res)<.08
period,phase=np.polyfit(indices[good],times[good],1)
phase=phase%period
res=times[good]-(phase+np.rint((times[good]-phase)/period)*period)
print('beat fit',json.dumps({'bpm':60/period,'phase':phase,'mean_abs_ms':float(np.mean(abs(res))*1000),'max_abs_ms':float(max(abs(res))*1000),'score':score}))
# Use a short lead-in to balance the measured kick offsets across the edit.
# This is a music edit decision, not compensation for an audio output delay.
beat_grid_source_start=phase+8*period
music_lead_in_adjust_seconds=-.0369
source_start=beat_grid_source_start+music_lead_in_adjust_seconds
starts=[0,12,32,48,136,152,168,188,204]
frames=[round(b*period*30) for b in starts]
frames[7]+=1  # Align the outro to the measured bass transient, within one frame of the grid.
duration=frames[-1]/30
raw=subprocess.check_output([FFMPEG,'-v','error','-ss',str(source_start),'-i',str(music),'-t',str(duration),'-f','wav','-c:a','pcm_s16le','-ac','2','-ar','48000','-'])
with wave.open(io.BytesIO(raw)) as f:
    pcm=np.frombuffer(f.readframes(f.getnframes()),np.int16).reshape(-1,2).astype(np.float32)
t=np.arange(len(pcm))/48000
gain=np.minimum(np.minimum(t/.45,(duration-t)/2),1).clip(0,1)
pcm=np.rint(pcm*gain[:,None]).clip(-32768,32767).astype(np.int16)
with wave.open(str(OUT/'house-vibez-edit.wav'),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(48000);f.writeframes(pcm.tobytes())
sfx={
 'soft':'transition/transition-soft.mp3',
 'sweep':'transition/swoosh-quick.mp3',
 'whoosh':'transition/whoosh-fast.mp3',
 'switch':'ui/switch-light.mp3',
 'impact':'impact/impact-deep-whoosh.mp3',
 'sparkle':'light/shimmer-sparkle-sweep.mp3',
}
metadata={}
for name,rel in sfx.items():
    src=SKILL/'assets/audio/sfx'/rel
    a=decode(src)
    rms=np.convolve(a.astype(np.float64)**2,np.ones(220)/220,mode='same')
    peak=float(np.argmax(rms)/SR)
    # Decode to lossless PCM so remuxed MP3 delay does not vary across sound effects.
    subprocess.run([FFMPEG,'-v','error','-y','-i',str(src),'-ar','48000','-ac','2',str(OUT/(name+'.wav'))],check=True)
    metadata[name]={'source':rel,'duration':len(a)/SR,'peak_seconds':peak,'max_db':float(20*np.log10(max(abs(a))+1e-9))}
# A short rising air cue derived from the verified whoosh asset, ending before
# the impact. Preserve its provenance and measure the new envelope peak.
with wave.open(str(OUT/'whoosh.wav')) as f:
    rise=np.frombuffer(f.readframes(round(.745*48000)),np.int16).reshape(-1,2).astype(np.float64)
rt=np.arange(len(rise))/48000
rg=(.2+.8*rt/.745)*np.minimum((.745-rt)/.015,1).clip(0,1)
rise=np.rint(rise*rg[:,None]).clip(-32768,32767).astype(np.int16)
with wave.open(str(OUT/'riser.wav'),'wb') as f:
    f.setnchannels(2);f.setsampwidth(2);f.setframerate(48000);f.writeframes(rise.tobytes())
a=rise.astype(float).mean(axis=1)/32768
rms=np.convolve(a*a,np.ones(480)/480,mode='same')
metadata['riser']={'source':'transition/whoosh-fast.mp3','derivation':'first 0.745 seconds, rising gain 0.2 to 1.0, 15 ms end fade','duration':len(a)/48000,'peak_seconds':float(np.argmax(rms)/48000),'max_db':float(20*np.log10(max(abs(a))+1e-9))}
result={'bpm':60/period,'period':period,'source_start':source_start,'beat_grid_source_start':beat_grid_source_start,'music_lead_in_adjust_seconds':music_lead_in_adjust_seconds,'source_file':'House Vibez — Lily J','beat_fit_mean_abs_ms':float(np.mean(abs(res))*1000),'beat_fit_max_abs_ms':float(max(abs(res))*1000),'shot_beats':starts,'shot_frames':frames,'total_frames':frames[-1],'sfx':metadata}
(ROOT/'src/audio-timing.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
