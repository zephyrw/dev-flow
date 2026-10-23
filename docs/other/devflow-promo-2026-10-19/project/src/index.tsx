import React from 'react';
import {Composition,registerRoot} from 'remotion';
import {BGM,DevFlowPromo,SFX,SHOTS,TOTAL} from './Main';
const Root:React.FC=()=> <Composition id="DevFlowPromo" component={DevFlowPromo} width={1920} height={1080} fps={30} durationInFrames={TOTAL} defaultProps={{withMusic:true,timeline:{fps:30,total:TOTAL,shots:SHOTS.map(({id,label,from,duration})=>({id,label,from,duration})),sfx:SFX,bgm:BGM}}}/>;
registerRoot(Root);
