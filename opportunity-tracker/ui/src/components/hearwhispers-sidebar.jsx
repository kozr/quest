import { AtSign, AudioLines, ChartNoAxesCombined, ChevronsUpDown, Clapperboard, ListTodo, MessageSquareText, MessagesSquare, Package2, Plus, ScanLine, Search, Settings2, Users } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { BrandIcon } from "@/components/brand-icon";

import {defaultPurposes,purposes,loadActivePurpose} from "@/purposes.mjs";
const purposeIcons={mentions:AtSign,opportunities:Users,feedback:MessagesSquare,competitors:ScanLine};

export function AppSidebar({ view, navigate, products, productId, allowAllProducts, onProduct, onAdd, storage, enabledPurposes=defaultPurposes, onPurposes }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const productName = products.find(product => product.id === productId)?.name || (products.length ? "All products" : "Choose a product");
  function go(next) { navigate(next); setOpenMobile(false); }
  function item(id, label, Icon) {
    const active=view===id;
    return <SidebarMenuItem key={id}><SidebarMenuButton isActive={active} tooltip={label} onClick={() => go(id)} aria-current={active ? "page" : undefined}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>;
  }
  return <Sidebar collapsible="icon">
    <SidebarHeader>
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton size="lg" onClick={() => go(loadActivePurpose(enabledPurposes))} tooltip="HearWhispers">
          <BrandIcon className="size-8" />
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
          {purposes.filter(purpose=>enabledPurposes.includes(purpose.id)).map(purpose=>item(purpose.id,purpose.label,purposeIcons[purpose.id]))}
          <SidebarMenuItem><SidebarMenuButton className="text-muted-foreground" tooltip={enabledPurposes.length<purposes.length?"Add purpose":"Manage purposes"} onClick={()=>{setOpenMobile(false);onPurposes();}}><Plus/><span>{enabledPurposes.length<purposes.length?"Add purpose":"Manage purposes"}</span></SidebarMenuButton></SidebarMenuItem>
          {[{id:"products",label:"Products",icon:Package2},{id:"listening",label:"Listening",icon:AudioLines},{id:"insights",label:"Insights",icon:ChartNoAxesCombined},{id:"research",label:"Research",icon:Search}].map(({id,label,icon:Icon})=>item(id,label,Icon))}
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup>
        <SidebarGroupLabel>ActOnWhispers</SidebarGroupLabel>
        <SidebarGroupContent><SidebarMenu>
          {item("actions", "Actions", ListTodo)}
          {item("replies", "Auto-draft replies", MessageSquareText)}
          {item("content", "Videos & captions", Clapperboard)}
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarMenu>
      {item("settings", "Settings", Settings2)}
    </SidebarMenu></SidebarFooter>
    <SidebarRail />
  </Sidebar>;
}
