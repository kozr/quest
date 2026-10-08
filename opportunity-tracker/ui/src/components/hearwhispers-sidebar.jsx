import { AudioLines, Bookmark, ChartNoAxesCombined, ChevronsUpDown, FilePenLine, Inbox, Package2, Plus, Search, Settings2, SquareStack } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AppSidebar({ view, navigate, products, productId, allowAllProducts, onProduct, onAdd, storage }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const productName = products.find(product => product.id === productId)?.name || (products.length ? "All products" : "Choose a product");
  function go(next) { navigate(next); setOpenMobile(false); }
  function item(id, label, Icon) {
    return <SidebarMenuItem key={id}><SidebarMenuButton isActive={view === id} tooltip={label} onClick={() => go(id)} aria-current={view === id ? "page" : undefined}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>;
  }
  return <Sidebar collapsible="icon">
    <SidebarHeader>
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton size="lg" onClick={() => go("conversations")} tooltip="HearWhispers">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><SquareStack className="size-4" /></div>
          <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">HearWhispers</span><span className="truncate text-xs text-muted-foreground">{storage === "cloud" ? "Private workspace" : "Local workspace"}</span></div>
        </SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
      <SidebarMenu><SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><SidebarMenuButton aria-label={`Switch product: ${productName}`} tooltip={`Switch product: ${productName}`} className="data-[state=open]:bg-sidebar-accent"><Package2 /><span>{productName}</span><ChevronsUpDown className="ml-auto" /></SidebarMenuButton></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side={isMobile ? "bottom" : "right"} sideOffset={4} className="min-w-56 max-w-[calc(100vw-2rem)]">
            <DropdownMenuLabel>Products</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={productId} onValueChange={id => {onProduct(id); setOpenMobile(false);}}>
              {allowAllProducts && products.length > 0 && <DropdownMenuRadioItem value="all">All products</DropdownMenuRadioItem>}
              {products.map(product => <DropdownMenuRadioItem key={product.id} value={product.id}>{product.name}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => {setOpenMobile(false); onAdd();}}><Plus />Add product</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem></SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>HearWhispers</SidebarGroupLabel>
        <SidebarGroupContent><SidebarMenu>
          {[{id:"conversations", label:"Conversations", icon:Inbox},{id:"saved",label:"Saved",icon:Bookmark},{id:"products",label:"Products",icon:Package2},{id:"listening",label:"Listening",icon:AudioLines},{id:"insights",label:"Insights",icon:ChartNoAxesCombined},{id:"research",label:"Research",icon:Search}].map(({id,label,icon:Icon}) => item(id,label,Icon))}
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>ActOnWhispers</SidebarGroupLabel>
        <SidebarGroupContent><SidebarMenu>
          {item("actions", "Actions & drafts", FilePenLine)}
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarMenu>
      {item("settings", "Settings", Settings2)}
    </SidebarMenu></SidebarFooter>
    <SidebarRail />
  </Sidebar>;
}
