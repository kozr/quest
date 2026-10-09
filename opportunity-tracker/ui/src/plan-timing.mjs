// The backend's effective schedule is authoritative. Subscription-only pilot
// responses retain the catalog cadence without requiring the account UI.
const MINUTE=60000;
const catalogMinutes={starter:{keyword:60,long_tail:1440,analysis:1440},growth:{keyword:15,long_tail:360,analysis:60},team:{keyword:5,long_tail:60,analysis:15}};
const valid=value=>Number.isFinite(value)&&value>0;
export function planIntervals(state={},productId){
 const schedule=productId?state.schedules?.[productId]:state.schedules;
 const fallback=catalogMinutes[state.subscription?.planId],result={};
 for(const loop of ['keyword','long_tail','analysis']){
  const values=[schedule?.[loop]?.intervalMs,state.entitlements?.intervals?.[loop],fallback?.[loop]*MINUTE];
  const interval=values.find(valid);if(interval!==undefined)result[loop]=interval;
 }
 return Object.keys(result).length?result:null;
}
export function cadenceLabel(ms){if(!valid(ms))return 'Schedule unavailable';const minutes=ms/MINUTE;return minutes>=1440?`Every ${minutes===1440?'day':`${minutes/1440} days`}`:minutes>=60?`Every ${minutes===60?'hour':`${minutes/60} hours`}`:`Every ${minutes} minutes`;}
export function monitoringTiming(state,productId){const intervals=planIntervals(state,productId);return intervals?[['keyword','Keyword searches'],['long_tail','Long-tail discovery'],['analysis','AI analysis']].map(([loop,label])=>`${label} ${cadenceLabel(intervals[loop]).toLowerCase()}`).join(' · '):'Reddit and X monitoring every two hours';}
