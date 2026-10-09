export function canEditCollected(state,row){
 return row.reviewEditable!==false&&(!state.account||state.account.permissions?.write===true);
}
export function collectedReviewBody(current,accountMode=false){
 return {...(accountMode?{expectedVersion:current.version??0}:{}),note:current.note,draft:current.draft,status:current.status};
}
export function modernReviewSummary(state){
 if(!state.conversationPaging&&!state.account)return null;
 return (state.products||[]).filter(product=>!product.archived&&product.status!=='archived').reduce((total,product)=>{
  const summary=state.pipeline?.products?.[product.id]||{};
  total.pending+=summary.pending||0;total.failed+=summary.failed||0;return total;
 },{pending:0,failed:0});
}
