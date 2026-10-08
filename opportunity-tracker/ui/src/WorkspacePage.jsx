export function PageHeading({title,description,action}) {
 return <div className="page-heading"><div className="page-title"><h1>{title}</h1>{description&&<p>{description}</p>}</div>{action&&<div className="page-action">{action}</div>}</div>;
}
export function WorkspaceEmpty({title,description,children}) {
 return <div className="workspace-empty"><h2>{title}</h2><p>{description}</p>{children&&<div className="workspace-empty-action">{children}</div>}</div>;
}
export function WorkspaceNotice({title,description,children}) {
 return <div className="workspace-notice"><div><h2>{title}</h2><p>{description}</p></div>{children&&<div className="workspace-notice-action">{children}</div>}</div>;
}
