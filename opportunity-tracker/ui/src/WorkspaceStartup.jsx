import {LoaderCircle} from 'lucide-react';
import {BrandIcon} from '@/components/brand-icon';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';

const rowWidths=[56,68,47,62,52,72,58];

function StartupBrand({className=''}){
 return <div className={`workspace-skeleton-brand ${className}`}><BrandIcon/><h1>HearWhispers</h1></div>;
}

function SidebarRows({widths}){
 return <div className="workspace-skeleton-rows">
  {widths.map((width,index)=><div className="workspace-skeleton-nav-row" key={index}>
   <Skeleton className="workspace-skeleton-circle"/><Skeleton className="workspace-skeleton-label" style={{width}}/>
  </div>)}
 </div>;
}

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
  <div className="workspace-skeleton-sidebar">
   <StartupBrand/>
   <div className="workspace-skeleton-navigation" aria-hidden="true">
    <div className="workspace-skeleton-product"><Skeleton className="workspace-skeleton-circle"/><Skeleton className="workspace-skeleton-label"/></div>
    <SidebarRows widths={[112,136,92,120,104]}/>
    <SidebarRows widths={[88,128,112]}/>
    <div className="workspace-skeleton-settings"><SidebarRows widths={[76]}/></div>
   </div>
  </div>
  <div className="workspace-skeleton-workspace">
   <header className="workspace-skeleton-header">
    <StartupBrand className="workspace-skeleton-mobile-brand"/>
    <div className="workspace-skeleton-breadcrumb" aria-hidden="true">
     <Skeleton className="workspace-skeleton-toggle"/><Skeleton className="workspace-skeleton-crumb"/>
     <span>/</span><Skeleton className="workspace-skeleton-crumb"/>
     <span>/</span><Skeleton className="workspace-skeleton-crumb"/>
    </div>
    <Skeleton className="workspace-skeleton-account" aria-hidden="true"/>
   </header>
  <div className="workspace-skeleton-main">
   <p className="workspace-startup-status workspace-skeleton-status" role="status" aria-live="polite" aria-atomic="true">
    <LoaderCircle className="workspace-startup-spinner" aria-hidden="true"/>
    <span>Opening your workspace…</span>
   </p>
   <div className="workspace-skeleton-toolbar" aria-hidden="true">
    <Skeleton className="workspace-skeleton-title"/>
    <div className="workspace-skeleton-filters"><Skeleton/><Skeleton/><Skeleton/></div>
    <Skeleton className="workspace-skeleton-search"/>
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
  </div>
 </main>;
}
