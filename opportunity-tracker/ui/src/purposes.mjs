export const purposes=[
 {id:'mentions',relevance:'mentions',label:'Mentions',description:'Discussions about your business, product or work.'},
 {id:'opportunities',relevance:'direct',label:'Potential customers',description:'Conversations where your offering could help with an expressed need.'},
 {id:'feedback',relevance:'feedback',label:'Feedback',description:'Problems, requests and workarounds from your market.'},
 {id:'competitors',relevance:'competitors',label:'Competitors',description:'Comparisons, recommendations and experiences with alternatives.'},
];
export const defaultPurposes=['opportunities','feedback'];
export function normalizePurposes(value){
 if(!Array.isArray(value))return [...defaultPurposes];
 const selected=purposes.filter(purpose=>value.includes(purpose.id)).map(purpose=>purpose.id);
 return selected.length?selected:[...defaultPurposes];
}
const preferenceKey='hearwhispers:sidebar-purposes:v1';
const activePurposeKey='hearwhispers:active-purpose:v1';
export function loadPurposes(){try{return normalizePurposes(JSON.parse(localStorage.getItem(preferenceKey)));}catch{return [...defaultPurposes];}}
export function savePurposes(value){try{localStorage.setItem(preferenceKey,JSON.stringify(normalizePurposes(value)));return true;}catch{return false;}}
export function loadActivePurpose(enabled=loadPurposes()){
 const selected=normalizePurposes(enabled);
 try{const last=localStorage.getItem(activePurposeKey);if(selected.includes(last))return last;}catch{}
 return selected[0];
}
export function saveActivePurpose(id){try{localStorage.setItem(activePurposeKey,id);}catch{}}
