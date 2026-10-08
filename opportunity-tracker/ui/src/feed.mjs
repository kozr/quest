export function matchesConversation(item,{view='conversations',status='active',relevance='all'}={}){
  if(view==='saved')return item.status==='saved';
  if(status==='dismissed'){if(item.status!=='dismissed')return false;}
  else if((status==='active'?item.status==='dismissed':item.status!==status)||item.currentConversationRelevant===false)return false;
  if(relevance==='direct')return item.currentOpportunityFit===true||(item.currentOpportunityFit===undefined&&item.kind==='opportunity'&&item.qualification?.directFit!==false);
  if(relevance==='mentions')return item.kind==='mention';
  return true;
}
