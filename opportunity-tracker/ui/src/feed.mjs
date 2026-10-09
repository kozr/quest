export function matchesConversation(item,{view='conversations',status='active',relevance='all'}={}){
  if(view==='saved')return item.status==='saved';
  if(status==='dismissed'){if(item.status!=='dismissed')return false;}
  else if((status==='active'?item.status==='dismissed':item.status!==status)||item.currentConversationRelevant===false)return false;
  if(relevance==='direct'&&item.conversationSignals)return item.conversationSignals.some(signal=>signal.purpose==='potential_customer');
  if(relevance==='direct')return item.currentOpportunityFit===true||(item.currentOpportunityFit===undefined&&item.kind==='opportunity'&&item.qualification?.directFit!==false);
  if(relevance==='mentions')return (item.conversationSignals||item.qualification?.purposes)?.some(signal=>signal.purpose==='mention')??item.kind==='mention';
  if(relevance==='feedback')return item.conversationSignals?item.conversationSignals.some(signal=>signal.purpose==='feedback'):item.qualification?.relevant===true&&item.qualification.purposes?.some(signal=>signal.purpose==='feedback')||false;
  if(relevance==='competitors')return (item.conversationSignals||item.qualification?.purposes)?.some(signal=>signal.purpose==='competitor')||false;
  return true;
}

export function purposeEvidence(item,relevance='all'){
  const purpose={mentions:'mention',direct:'potential_customer',feedback:'feedback',competitors:'competitor'}[relevance];
  const all=item?.conversationSignals??item?.qualification?.purposes??[];
  const signals=purpose?all.filter(signal=>signal.purpose===purpose):all;
  const quote=signals.find(signal=>signal.quote)?.quote||(purpose?item?.snippet:item?.qualification?.intentQuote||item?.qualification?.quote||item?.snippet)||'';
  return {signals,quote};
}
