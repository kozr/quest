import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Bookmark, Check, Copy, Inbox, Info, Package2, Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { AppSidebar } from "@/components/hearwhispers-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { conversations, exampleProduct } from "./data";
import { LandingPage } from "./LandingPage";
import { loadPreviewState, storageKey } from "./lib/preview-storage";

const views = { conversations: "Conversations", saved: "Saved", products: "Products", settings: "Settings" };

function initialState() {
  try {
    return loadPreviewState(localStorage);
  } catch { /* Unavailable or outdated storage starts with the example workspace. */ }
  return loadPreviewState(null);
}
function currentView() { return views[location.hash.slice(1)] ? location.hash.slice(1) : "conversations"; }

export function App() {
  const [route, setRoute] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const update = () => { const next = location.hash.slice(1); if (next !== "main-content") setRoute(next); };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return views[route] ? <DashboardApp /> : <LandingPage />;
}

function DashboardApp() {
  const [state, setState] = useState(initialState);
  const [view, setView] = useState(currentView);
  const [query, setQuery] = useState("");
  const [productFilter, setProductFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [selectedId, setSelectedId] = useState(conversations[0].id);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const detailHeading = useRef(null);

  useEffect(() => {
    const update = () => {if (views[location.hash.slice(1)]) setView(currentView()); setMobileDetail(false);};
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [state]);
  useEffect(() => { document.title = `${views[view]} · HearWhispers`; }, [view]);
  useEffect(() => { if (mobileDetail && window.matchMedia("(max-width: 900px)").matches) detailHeading.current?.focus(); }, [mobileDetail, selectedId]);
  useEffect(() => { if (productFilter !== "all" && !state.products.some(p => p.id === productFilter)) setProductFilter("all"); }, [state.products, productFilter]);

  function navigate(next) { location.hash = next; setView(next); setMobileDetail(false); }
  function addProduct() { setEditing(null); setFormOpen(true); }
  function reviewStatus(id) { return state.review[id] || "new"; }
  function updateReview(id, status) {
    const previous = reviewStatus(id);
    setState(old => ({...old, review:{...old.review, [id]:status}}));
    toast(status === "saved" ? "Conversation saved" : status === "dismissed" ? "Conversation dismissed" : "Moved to New", {
      action: {label:"Undo", onClick:() => setState(old => ({...old, review:{...old.review,[id]:previous}}))}
    });
  }
  const filtered = useMemo(() => conversations.filter(item => {
    const status = state.review[item.id] || "new";
    const matchesStatus = view === "saved" ? status === "saved" : statusFilter === "active" ? status !== "dismissed" : status === statusFilter;
    return matchesStatus && (productFilter === "all" || item.productId === productFilter) && `${item.title} ${item.summary} ${item.community}`.toLowerCase().includes(query.toLowerCase());
  }), [state.review, productFilter, statusFilter, query, view]);
  const selected = filtered.find(item => item.id === selectedId) || filtered[0];
  const isFeed = view === "conversations" || view === "saved";

  async function copyDraft() {
    try { await navigator.clipboard.writeText(state.drafts[selected.id] || ""); toast("Draft copied"); }
    catch { toast.error("Could not copy. Select the draft text and copy it manually."); }
  }
  function saveProduct(product) {
    const record = editing ? {...editing, ...product} : {...product, id:crypto.randomUUID(), example:false};
    const previous = editing;
    setState(old => ({...old, products:editing ? old.products.map(p => p.id === editing.id ? record : p) : [...old.products, record]}));
    setFormOpen(false);
    toast(editing ? "Product updated on this device" : "Product added to this preview", {action:{label:"Undo",onClick:() => setState(old => ({...old,products:previous ? old.products.map(p => p.id === record.id ? previous : p) : old.products.filter(p => p.id !== record.id)}))}});
  }

  return <SidebarProvider className="review-desk" style={{"--sidebar-width":"15rem"}}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <AppSidebar view={view} navigate={navigate} products={state.products} onAdd={addProduct} onProduct={id => {setProductFilter(id); setStatusFilter("active"); setQuery(""); navigate("conversations");}} />
    <SidebarInset className="min-w-0">
      <header className="workspace-header">
        <SidebarTrigger /><Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <span className="text-sm text-muted-foreground hidden sm:inline">Workspace</span><span className="text-muted-foreground/50 hidden sm:inline">/</span><span className="text-sm">{views[view]}</span>
        <Badge variant="outline" className="ml-auto font-normal text-muted-foreground">Local preview</Badge>
      </header>
      <section id="main-content" aria-label={views[view]} className="workspace-main" tabIndex={-1}>
        <div className="page-heading">
          <div className="page-title"><h1>{views[view]}</h1>{isFeed && <p className="feed-disclosure" role="status">{filtered.length} historical {filtered.length === 1 ? "example" : "examples"}<span aria-hidden="true"> · </span>Live discovery is not connected</p>}</div>
          <div className="feed-toolbar">
            <Button onClick={addProduct} variant="outline" className="add-product"><Plus />Add product</Button>
            {isFeed && <>
              <div className="search-field"><Search aria-hidden="true" /><Input value={query} onChange={e => {setQuery(e.target.value); setMobileDetail(false);}} placeholder="Search conversations" aria-label="Search conversations" /></div>
              <Select value={productFilter} onValueChange={value => {setProductFilter(value); setMobileDetail(false);}}><SelectTrigger aria-label="Filter by product" className="product-filter"><Package2 /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All products</SelectItem>{state.products.map(product => <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>)}</SelectContent></Select>
            </>}
          </div>
        </div>
        {storageError && <p role="alert" className="storage-error">Changes could not be saved on this device. Keep this tab open to retain them.</p>}
        {isFeed && <div className={`feed-view ${mobileDetail ? "show-detail" : ""}`}>
          <div className="feed-subheader">
            {view === "conversations" ? <Tabs value={statusFilter} onValueChange={value => {setStatusFilter(value); setMobileDetail(false);}}><TabsList><TabsTrigger value="active">All active</TabsTrigger><TabsTrigger value="new">New</TabsTrigger><TabsTrigger value="dismissed">Dismissed</TabsTrigger></TabsList></Tabs> : <span className="text-sm text-muted-foreground">Saved conversations</span>}
            <span className="workspace-date">{new Intl.DateTimeFormat("en-US", {month:"long", day:"numeric", year:"numeric"}).format(new Date())}</span>
          </div>
          <div className="conversation-list" aria-label="Conversations">
            {filtered.length ? <>
              <div className="conversation-columns" aria-hidden="true"><span>Conversation</span><span>Source</span><span>Posted</span></div>
              {filtered.map(item => <button id={`conversation-${item.id}`} key={item.id} className={`conversation-row ${item.id === selected?.id ? "selected" : ""}`} onClick={() => {setSelectedId(item.id); setMobileDetail(true);}} aria-pressed={item.id === selected?.id}>
                <span className="row-title">{item.title}{reviewStatus(item.id) === "saved" && <Bookmark aria-label="Saved" className="size-3.5 fill-current" />}</span>
                <span className="row-source">{item.community}</span><span className="row-date">{item.date.replace("March", "Mar")}</span>
              </button>)}
            </> : <div className="list-empty"><Inbox className="size-5 text-muted-foreground" /><p>No conversations</p><span>{query ? "Try another search." : productFilter !== "all" && productFilter !== exampleProduct.id ? "Search is not connected in this local preview." : view === "saved" ? "Save a conversation to find it here." : "There are no conversations in this view."}</span><Button variant="outline" size="sm" onClick={() => {setQuery(""); setProductFilter("all"); setStatusFilter("active"); navigate("conversations");}}>View all active</Button></div>}
          </div>
          {selected && <article className="review-workspace" aria-label={selected.title}>
            <Button variant="ghost" size="sm" className="back-to-list" onClick={() => {setMobileDetail(false); requestAnimationFrame(() => document.getElementById(`conversation-${selected.id}`)?.focus());}}><ArrowLeft />All conversations</Button>
            <section className="source-context" aria-labelledby="context-heading">
              <h2 id="context-heading" ref={detailHeading} tabIndex={-1}>Source and context</h2>
              <p className="mobile-conversation-title">{selected.title}</p>
              <p className="detail-byline"><span>{selected.author}</span><span aria-hidden="true">·</span><span>{selected.community}</span><span aria-hidden="true">·</span><span>{selected.date}</span></p>
              <figure className="source-quote"><figcaption>From the post</figcaption><blockquote>“{selected.quote}”</blockquote></figure>
              <p className="source-summary">{selected.summary}</p>
              <section className="relevance"><h3>Potential fit</h3><p>{selected.relevance}</p></section>
              <div className="detail-actions">
                <Button asChild className="source-button"><a href={selected.url} target="_blank" rel="noopener noreferrer">Open original post<ArrowUpRight /></a></Button>
                <Button variant={reviewStatus(selected.id) === "saved" ? "secondary" : "outline"} onClick={() => updateReview(selected.id, reviewStatus(selected.id) === "saved" ? "new" : "saved")}><Bookmark className={reviewStatus(selected.id) === "saved" ? "fill-current" : ""} />{reviewStatus(selected.id) === "saved" ? "Saved" : "Save"}</Button>
                <Button variant="ghost" onClick={() => updateReview(selected.id, reviewStatus(selected.id) === "dismissed" ? "new" : "dismissed")}>{reviewStatus(selected.id) === "dismissed" ? <><Check />Restore</> : <><X />Dismiss</>}</Button>
              </div>
            </section>
            <section className="draft-section" aria-labelledby="draft-heading">
              <div className="draft-heading"><h2 id="draft-heading"><label htmlFor={`draft-${selected.id}`}>Draft response</label></h2><span>{storageError ? "Not saved" : "Saved on this device"}</span></div>
              <Textarea id={`draft-${selected.id}`} value={state.drafts[selected.id] || ""} onChange={e => setState(old => ({...old, drafts:{...old.drafts, [selected.id]:e.target.value}}))} placeholder="Write a helpful response…" className="draft-input" />
              <div className="draft-footer"><span>Copy your draft to respond on Reddit.</span><Button variant="outline" disabled={!state.drafts[selected.id]?.trim()} onClick={copyDraft}><Copy />Copy draft</Button></div>
            </section>
          </article>}
        </div>}
        {view === "products" && <div className="products-view"><div className="product-table-heading"><span>Product</span><span>Website</span><span /></div>{state.products.map(product => <div className="product-record" key={product.id}><div className="product-name"><div className="product-icon"><Package2 /></div><div><strong>{product.name}</strong><span>{product.example ? "Example product" : "Local preview"}</span></div></div><span className="product-website">{product.website || "Website not set"}</span><Button variant="outline" size="sm" onClick={() => {setEditing(product); setFormOpen(true);}}>Edit</Button></div>)}<p className="view-note"><Info className="size-4" />Products are stored on this device. Live discovery is not connected.</p></div>}
        {view === "settings" && <div className="settings-view"><section><h2>Workspace</h2><dl><div><dt>Name</dt><dd>HearWhispers</dd></div><div><dt>Mode</dt><dd>Local preview</dd></div><div><dt>Storage</dt><dd>This browser</dd></div></dl></section><section><h2>Preview data</h2><p>Conversations are historical public examples. Products, review status, and draft responses are saved on this device.</p></section><section><h2>Design sources</h2><a href="https://ui.shadcn.com/blocks/sidebar#sidebar-07" target="_blank" rel="noopener noreferrer">shadcn/ui sidebar-07<ArrowUpRight className="size-4" /></a></section></div>}
      </section>
    </SidebarInset>
    <ProductForm key={editing?.id || `new-${formOpen}`} open={formOpen} onOpenChange={setFormOpen} product={editing} onSave={saveProduct} />
    <Toaster position="bottom-right" theme="light" />
  </SidebarProvider>;
}

function ProductForm({ open, onOpenChange, product, onSave }) {
  const [name, setName] = useState(product?.name || "");
  const [website, setWebsite] = useState(product?.website || "");
  const [description, setDescription] = useState(product?.description || "");
  const [error, setError] = useState("");
  function submit(event) {
    event.preventDefault();
    let url;
    try {url = new URL(website.trim()); if (!["https:","http:"].includes(url.protocol)) throw new Error();}
    catch {setError("Enter a website beginning with https:// or http://."); return;}
    if (!name.trim()) {setError("Enter a product name."); return;}
    onSave({name:name.trim(), website:url.href, description:description.trim()});
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-[480px]"><DialogHeader><DialogTitle>{product ? "Edit product" : "Add product"}</DialogTitle><DialogDescription>Product details are saved in this local preview.</DialogDescription></DialogHeader><form onSubmit={submit} className="product-form"><div><label htmlFor="product-name">Name</label><Input id="product-name" value={name} onChange={e => setName(e.target.value)} maxLength={100} required autoComplete="off" /></div><div><label htmlFor="product-website">Website</label><Input id="product-website" type="url" value={website} onChange={e => setWebsite(e.target.value)} placeholder="https://yourproduct.com" maxLength={2048} required autoComplete="url" aria-describedby={error ? "product-error" : undefined} /></div><div><label htmlFor="product-description">What does it do?</label><Textarea id="product-description" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} /></div>{error && <p role="alert" id="product-error" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit">{product ? "Save changes" : "Add product"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
