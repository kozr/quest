import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, Bookmark, ChevronDown, FilePenLine, Inbox, Link2, Menu, Package2, Search, SquareStack } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { conversations } from "./data";

const features = [
  {icon:Package2, title:"Products", description:"Keep each product’s website and description in one place."},
  {icon:Search, title:"Search", description:"Filter conversations by product or search their text."},
  {icon:Link2, title:"Original sources", description:"Open the full discussion to read its context."},
  {icon:Bookmark, title:"Saved conversations", description:"Save discussions you want to return to."},
  {icon:FilePenLine, title:"Draft responses", description:"Write and edit a response before copying it."},
  {icon:Inbox, title:"Review status", description:"Keep new, saved, and dismissed conversations organized."},
];

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {document.title="HearWhispers";}, []);
  return <div className="landing-page" id="home">
    <a href="#landing-main" className="skip-link">Skip to content</a>
    <header className="landing-nav">
      <a className="landing-brand" href="#home"><SquareStack aria-hidden="true" /><span>HearWhispers</span></a>
      <nav aria-label="Main navigation" className="landing-desktop-nav">
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm">Product<ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-52"><DropdownMenuItem asChild><a href="#product"><Package2 />Product details</a></DropdownMenuItem><DropdownMenuItem asChild><a href="#dashboard-preview"><Inbox />Dashboard preview</a></DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <a href="#example">Example</a><a href="#conversations">Dashboard</a>
      </nav>
      <Button asChild size="sm" className="landing-nav-action"><a href="#conversations">Open dashboard<ArrowUpRight /></a></Button>
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="landing-mobile-menu" aria-label="Open navigation"><Menu /></Button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>HearWhispers</SheetTitle></SheetHeader><nav aria-label="Mobile navigation" className="mobile-links">{[{label:"Product",href:"#product"},{label:"Example",href:"#example"},{label:"Dashboard",href:"#conversations"}].map(link => <SheetClose asChild key={link.href}><a href={link.href}>{link.label}<ArrowUpRight className="size-4" /></a></SheetClose>)}</nav></SheetContent></Sheet>
    </header>
    <main id="landing-main">
      <section className="landing-hero" aria-labelledby="landing-title">
        <img src="/assets/wire-top.png" alt="" aria-hidden="true" className="hero-wire wire-top" />
        <img src="/assets/wire-bottom.png" alt="" aria-hidden="true" className="hero-wire wire-bottom" />
        <img src="/assets/wire-left.png" alt="" aria-hidden="true" className="hero-wire wire-left" />
        <img src="/assets/wire-right.png" alt="" aria-hidden="true" className="hero-wire wire-right" />
        <div className="landing-hero-content">
          <Badge variant="secondary" className="font-normal">Web preview</Badge>
          <h1 id="landing-title">HearWhispers</h1>
          <p>Find public discussions related to your product.<br className="hidden sm:block" /> Review the source, save conversations, and draft a response.</p>
          <div className="landing-hero-actions"><Button variant="outline" asChild><a href="#example">View example<ArrowUpRight /></a></Button><Button asChild><a href="#conversations">Open dashboard<ArrowRight /></a></Button></div>
        </div>
      </section>
      <section className="landing-example landing-container" id="example" aria-labelledby="example-title">
        <p className="section-label">Public discussion</p>
        <h2 id="example-title">{conversations[0].title}</h2>
        <p className="landing-source-meta">{conversations[0].community}<span>·</span>{conversations[0].date}<span>·</span>Historical example</p>
        <a className="text-link" href={conversations[0].url} target="_blank" rel="noopener noreferrer">Read original post<ArrowUpRight className="size-4" /></a>
      </section>
      <section className="landing-product landing-container" id="product" aria-labelledby="product-title">
        <h2 id="product-title">Product</h2>
        <div className="landing-feature-grid">{features.map(({icon:Icon,title,description}) => <div key={title} className="landing-feature"><div className="feature-icon"><Icon /></div><h3>{title}</h3><p>{description}</p></div>)}</div>
      </section>
      <section className="landing-dashboard" id="dashboard-preview" aria-labelledby="dashboard-title">
        <div className="landing-container"><div className="landing-section-heading"><h2 id="dashboard-title">Dashboard</h2><Button variant="outline" asChild><a href="#conversations">Open preview<ArrowUpRight /></a></Button></div><a href="#conversations" className="dashboard-image-link" aria-label="Open the dashboard preview"><img src="/assets/dashboard-preview.jpg" alt="HearWhispers dashboard showing the collapsible sidebar, conversation list, original source, review actions, and draft response field." width="1280" height="960" loading="lazy" /></a><p className="landing-preview-note">The preview contains historical example discussions. Changes are saved on this device.</p></div>
      </section>
    </main>
    <footer className="landing-footer landing-container"><a className="landing-brand" href="#home"><SquareStack aria-hidden="true" /><span>HearWhispers</span></a><nav aria-label="Footer navigation"><a href="#product">Product</a><a href="#example">Example</a><a href="#conversations">Dashboard</a></nav><span>Local preview</span></footer>
  </div>;
}
