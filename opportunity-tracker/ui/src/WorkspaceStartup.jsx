import {LoaderCircle} from 'lucide-react';
import {BrandIcon} from '@/components/brand-icon';
import {Button} from '@/components/ui/button';

export function WorkspaceStartup({error,onRetry,retryLabel='Try again'}){
 return <main className="workspace-startup review-desk" aria-label="HearWhispers workspace">
  <div className="workspace-startup-content">
   <div className="workspace-startup-brand">
    <BrandIcon className="workspace-startup-icon"/>
    <h1>HearWhispers</h1>
   </div>
   {error?<div className="workspace-startup-error">
    <div role="alert"><h2>Unable to open your workspace</h2><p>{error}</p></div>
    <Button onClick={onRetry}>{retryLabel}</Button>
   </div>:<p className="workspace-startup-status" role="status" aria-live="polite" aria-atomic="true">
    <LoaderCircle className="workspace-startup-spinner" aria-hidden="true"/>
    <span>Opening your workspace…</span>
   </p>}
  </div>
 </main>;
}
