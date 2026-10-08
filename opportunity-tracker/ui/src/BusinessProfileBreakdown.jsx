import {Button} from '@/components/ui/button';
import {safeURL} from './api';

export function breakdownMatches(profile,values) {
  if(!profile)return false;
  let url;
  try {url=new URL(values.url).href;} catch {return false;}
  return profile.business?.name===values.name.trim() && profile.business?.url===url
    && profile.sources?.find(s=>s.id==='description')?.text===values.description.trim();
}

export function BusinessProfileBreakdown({profile,onChange,onGenerate,busy,available,current}) {
  function remove(key,index) {
    const next={...profile,reviewed:false,[key]:profile[key].filter((_,i)=>i!==index)};
    if(key==='offerings') {
      const ids=new Set(next.offerings.map(row=>row.id));
      for(const group of ['audiences','needs'])next[group]=next[group].map(row=>({...row,offeringIds:row.offeringIds.filter(id=>ids.has(id))})).filter(row=>row.offeringIds.length);
    }
    onChange(next);
  }
  return <section className="business-breakdown" aria-label="Business breakdown">
    <p className="field-help">Separate what your business offers from assumptions about its customers. Review this breakdown before using it to find conversations.</p>
    <Button type="button" variant={profile?'outline':'default'} disabled={busy||!available} onClick={onGenerate}>{busy?'Preparing breakdown…':profile?'Refresh business breakdown':'Generate business breakdown'}</Button>
    {!available&&<p className="field-help">Generation is paused. Existing breakdowns remain available to review.</p>}
    {profile&&<>
      {!current&&<p role="status" className="form-error">Business details changed. Refresh this breakdown before using it.</p>}
      {profile.limitations.map((line,i)=><p className="field-help" key={i}>{line}</p>)}
      {[
        ['offerings','What the business offers'],['audiences','Who it could help'],
        ['needs','Customer needs it could address'],['constraints','Limits and conditions'],
      ].map(([key,title])=><section key={key} className="breakdown-group">
        <h3>{title}</h3>
        {!profile[key].length&&<p className="field-help">No supported entries yet.</p>}
        <ul>{profile[key].map((row,i)=><li key={row.id||i}>
          <div className="breakdown-entry"><span>{row.label||row.text}</span><Button type="button" variant="ghost" size="sm" aria-label={`Remove ${row.label||row.text}`} onClick={()=>remove(key,i)}>Remove</Button></div>
          {row.basis==='hypothesis'?<p className="field-help">Inferred from the offering. This is not evidence of customer demand.</p>:<details><summary>Source evidence</summary><blockquote>{row.quote}</blockquote><p className="field-help">{row.sourceId==='description'?'Provided description':'Official page'}{row.sourceId==='website'&&<>{' · '}<a href={safeURL(profile.sources.find(s=>s.id==='website')?.url)} target="_blank" rel="noreferrer">Open source</a></>}</p></details>}
        </li>)}</ul>
      </section>)}
      {!!profile.unknowns.length&&<section className="breakdown-group"><h3>Still unknown</h3><ul>{profile.unknowns.map((value,i)=><li key={i}>{value}</li>)}</ul><p className="field-help">Add verified answers to the business description, then refresh the breakdown.</p></section>}
      <label className="check-field"><input type="checkbox" checked={profile.reviewed&&current} disabled={!current||!profile.offerings.length} onChange={e=>onChange({...profile,reviewed:e.target.checked})}/><span>I’ve reviewed the offerings, assumptions and limits.</span></label>
    </>}
  </section>;
}
