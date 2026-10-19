from pathlib import Path
import json, subprocess, wave, io, hashlib, argparse
import numpy as np
from scipy import signal
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT.parent
parser=argparse.ArgumentParser()
parser.add_argument('--output-dir')
args=parser.parse_args()
DEST=Path(args.output_dir).resolve() if args.output_dir else OUT
BIN=Path(r'C:/Users/yckj4798/.codex/skills/video-shotcraft/workbench/node_modules/.pnpm/@remotion+compositor-win32-x64-msvc@4.0.484/node_modules/@remotion/compositor-win32-x64-msvc')
FF=str(BIN/'ffmpeg.exe');FP=str(BIN/'ffprobe.exe')
MAN=json.loads((ROOT/'export-timeline.json').read_text(encoding='utf-8'))
def wav_data(raw):
    with wave.open(io.BytesIO(raw)) as f:return np.frombuffer(f.readframes(f.getnframes()),np.int16).reshape(-1,f.getnchannels()).astype(np.float64)/32768
def decode(file):return wav_data(subprocess.check_output([FF,'-v','error','-i',str(file),'-vn','-f','wav','-c:a','pcm_s16le','-ar','48000','-ac','2','-']))
report={'date':'2026-10-19','pipeline':{'renderer':'Remotion 4.0.484','fps':30,'mix':'48 kHz stereo PCM, SFX source-peak compensated','mux':'FFmpeg bundled with Remotion; H.264 picture copied + AAC 256k'},'files':{}}
for name in ['music','no-bgm']:
    file=DEST/f'DevFlow-{name}-1080p.mp4'
    probe=json.loads(subprocess.check_output([FP,'-v','error','-show_streams','-show_format','-of','json',str(file)]))
    video=next(s for s in probe['streams'] if s['codec_type']=='video');audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
    stream=subprocess.check_output([FF,'-v','error','-i',str(file),'-map','0:v:0','-c','copy','-f','h264','-'])
    samples=decode(file)
    report['files'][name]={'bytes':file.stat().st_size,'duration':probe['format']['duration'],'width':video['width'],'height':video['height'],'frame_rate':video['r_frame_rate'],'frames':video.get('nb_frames'),'video_codec':video['codec_name'],'audio_codec':audio['codec_name'],'video_stream_sha256':hashlib.sha256(stream).hexdigest(),'decoded_peak_dbfs':float(20*np.log10(max(abs(samples).max(),1e-10)))}
    if name=='no-bgm':decoded=samples
expected=np.zeros((round(MAN['total']/MAN['fps']*48000),2),np.float64)
for cue in MAN['sfx']:
    src=wav_data((ROOT/'public'/cue['src']).read_bytes());at=round(cue['from']/MAN['fps']*48000)
    end=min(len(expected),at+len(src),at+round(cue['duration']/MAN['fps']*48000))
    expected[at:end]+=src[:end-at]*cue['volume']
expected=np.rint(expected*32767).clip(-32768,32767)/32768
offsets=[]
for cue in MAN['sfx']:
    hit=round(cue['hit']/30*48000);start=max(0,hit-4800);end=min(len(expected),hit+9600)
    ref=expected[start:end].mean(axis=1);actual=decoded[max(0,start-2400):min(len(decoded),end+2400)].mean(axis=1)
    corr=signal.correlate(actual,ref,method='fft',mode='valid');lag=int(np.argmax(corr))-min(2400,start)
    offsets.append({'name':cue['name'],'hit_frame':cue['hit'],'output_offset_samples':lag,'output_offset_ms':lag/48,'frame_offset':lag/1600})
report['sfx_output_sync']=offsets
report['same_picture_stream']=report['files']['music']['video_stream_sha256']==report['files']['no-bgm']['video_stream_sha256']
assert report['same_picture_stream']
assert max(abs(x['frame_offset']) for x in offsets)<=1
assert all(v['frames']==str(MAN['total']) and v['width']==1920 and v['height']==1080 for v in report['files'].values())
(DEST/'export-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
