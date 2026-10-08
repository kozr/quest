import {LoaderCircle} from 'lucide-react';
import {BrandIcon} from '@/components/brand-icon';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';

const rowWidths=[56,68,47,62,52,72,58];

export function WorkspaceStartup({error,onRetry,retryLabel='Try again'}){
 if(error)return <main className="workspace-startup review-desk" aria-label="HearWhispers workspace">
  <div className="workspace-startup-content">
   <div className="workspace-startup-brand">
    <BrandIcon className="workspace-startup-icon"/>
    <h1>HearWhispers</h1>
   </div>
   <div className="workspace-startup-error">
    <div role="alert"><h2>Unable to open your workspace</h2><p>{error}</p></div>
    <Button onClick={onRetry}>{retryLabel}</Button>
   </div>
  </div>
 </main>;

 return <main className="workspace-skeleton review-desk" aria-label="HearWhispers workspace">
  <header className="workspace-skeleton-header">
   <div className="workspace-skeleton-brand"><BrandIcon/><h1>HearWhispers</h1></div>
   <Skeleton className="workspace-skeleton-account" aria-hidden="true"/>
  </header>
  <div className="workspace-skeleton-main">
   <p className="workspace-startup-status workspace-skeleton-status" role="status" aria-live="polite" aria-atomic="true">
    <LoaderCircle className="workspace-startup-spinner" aria-hidden="true"/>
    <span>Opening your workspace…</span>
   </p>
   <div className="workspace-skeleton-toolbar" aria-hidden="true">
    <Skeleton className="workspace-skeleton-title"/>
    <div className="workspace-skeleton-filters"><Skeleton/><Skeleton/></div>
   </div>
   <div className="workspace-skeleton-list" aria-hidden="true">
    {rowWidths.map((width,index)=><div className="workspace-skeleton-row" key={index}>
     <Skeleton className="workspace-skeleton-avatar"/>
     <div className="workspace-skeleton-row-text">
      <Skeleton className="workspace-skeleton-row-title" style={{width:`${width}%`}}/>
      <Skeleton className="workspace-skeleton-row-preview" style={{width:`${Math.min(width+24,92)}%`}}/>
     </div>
    </div>)}
   </div>
  </div>
 </main>;
}
