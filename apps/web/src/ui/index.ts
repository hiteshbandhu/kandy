/**
 * One import site for the primitives.
 *
 * shadcn owns the mechanics — focus, portals, keyboard behaviour, accessible
 * names — and this layer adds only what is specific to kandy: the candy tones,
 * the status vocabulary, and a couple of things shadcn has no opinion about.
 */
export { Button, buttonVariants } from "@/components/ui/button"
export { Input } from "@/components/ui/input"
export { Textarea } from "@/components/ui/textarea"
export { Separator } from "@/components/ui/separator"
export { Switch } from "@/components/ui/switch"
export { ScrollArea } from "@/components/ui/scroll-area"
export {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
export {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
export { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export * from "./Dot"
export * from "./Kbd"
export * from "./Empty"
export * from "./Spinner"
export * from "./Loading"
export * from "./Confirm"
export * from "./Hint"
