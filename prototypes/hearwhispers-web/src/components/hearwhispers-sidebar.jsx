import { ArrowUpRight, Bookmark, Inbox, Package2, Plus, Settings2, SquareStack } from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from "@/components/ui/sidebar";

export function AppSidebar({ view, navigate, products, onProduct, onAdd }) {
  const { setOpenMobile } = useSidebar();
  function go(next) { navigate(next); setOpenMobile(false); }
  return <Sidebar collapsible="icon">
    <SidebarHeader>
      <SidebarMenu><SidebarMenuItem>
        <SidebarMenuButton size="lg" onClick={() => go("conversations")} tooltip="HearWhispers">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><SquareStack className="size-4" /></div>
          <div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-semibold">HearWhispers</span><span className="truncate text-xs text-muted-foreground">Example workspace</span></div>
        </SidebarMenuButton>
      </SidebarMenuItem></SidebarMenu>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarGroupContent><SidebarMenu>
          {[{id:"conversations", label:"Conversations", icon:Inbox},{id:"saved",label:"Saved",icon:Bookmark},{id:"products",label:"Products",icon:Package2}].map(({id,label,icon:Icon}) =>
            <SidebarMenuItem key={id}><SidebarMenuButton isActive={view === id} tooltip={label} onClick={() => go(id)} aria-current={view === id ? "page" : undefined}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Products</SidebarGroupLabel>
        <SidebarGroupContent><SidebarMenu>
          {products.map(product => <SidebarMenuItem key={product.id}><SidebarMenuButton onClick={() => {onProduct(product.id); setOpenMobile(false);}}><Package2 /><span>{product.name}</span></SidebarMenuButton></SidebarMenuItem>)}
          <SidebarMenuItem><SidebarMenuButton className="text-muted-foreground" onClick={() => {setOpenMobile(false); onAdd();}}><Plus /><span>Add product</span></SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild tooltip="Website"><a href="#home"><ArrowUpRight /><span>Website</span></a></SidebarMenuButton></SidebarMenuItem><SidebarMenuItem><SidebarMenuButton isActive={view === "settings"} tooltip="Settings" onClick={() => go("settings")}><Settings2 /><span>Settings</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
    <SidebarRail />
  </Sidebar>;
}
