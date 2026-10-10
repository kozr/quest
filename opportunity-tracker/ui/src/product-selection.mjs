const preferenceKey=scope=>`hearwhispers.product.${scope||'private'}`;
export function selectedProductId(products,preferred){
 return products.some(product=>product.id===preferred)?preferred:products[0]?.id||'';
}
export function loadProductSelection(products,scope,storage){
 let preferred='';try{preferred=(storage??globalThis.localStorage)?.getItem(preferenceKey(scope));}catch{}
 return selectedProductId(products,preferred);
}
export function saveProductSelection(id,scope,storage){
 if(!id||id==='all')return;
 try{(storage??globalThis.localStorage)?.setItem(preferenceKey(scope),id);}catch{}
}
