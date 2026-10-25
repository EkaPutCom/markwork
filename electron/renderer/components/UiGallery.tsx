// The UI Gallery (docs/design/design-system.md, stage 4), in dev mode only: every primitive of ui/ in its states, the
// tokens and the text scale, and the patterns of docs/design/ui.md, drawn with the window's real theme, so a change to a
// primitive or a token is seen in one place, light and dark. It also opens the sample document with every element of the
// editor (tests/samples/ui-gallery.md). Ctrl+Alt+G opens and closes it (App.tsx).

import { useState, type ReactNode } from 'react';
import { useClient, useStore } from '../lib/useClient.js';
import { Icon } from './Icons.js';
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '../ui/alert-dialog.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../ui/card.js';
import { Checkbox } from '../ui/checkbox.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '../ui/command.js';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '../ui/context-menu.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog.js';
import {
    DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub,
    DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { IconButton } from '../ui/icon-button.js';
import { Input } from '../ui/input.js';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group.js';
import { toast } from 'sonner';
import { Kbd } from '../ui/kbd.js';
import { Label } from '../ui/label.js';
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarSeparator, MenubarShortcut, MenubarTrigger } from '../ui/menubar.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.js';
import { Select } from '../ui/select.js';
import { Separator } from '../ui/separator.js';
import { Spinner } from '../ui/spinner.js';
import { Switch } from '../ui/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.js';
import { Textarea } from '../ui/textarea.js';
import { Toggle } from '../ui/toggle.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';

export const UI_GALLERY_KEY = 'Ctrl+Alt+g';

// The class names are written out whole, so Tailwind finds them in the source.
const TEXT_SIZES = [
    { name: 'text-2xs', px: 11, className: 'text-2xs' },
    { name: 'text-xs', px: 12, className: 'text-xs' },
    { name: 'text-ui', px: 13, className: 'text-ui' },
    { name: 'text-sm', px: 14, className: 'text-sm' },
    { name: 'text-base', px: 16, className: 'text-base' },
    { name: 'text-lg', px: 18, className: 'text-lg' },
    { name: 'text-2xl', px: 24, className: 'text-2xl' },
];
const SURFACES = [
    { name: 'background', className: 'bg-background text-foreground' },
    { name: 'card', className: 'bg-card text-card-foreground' },
    { name: 'popover', className: 'bg-popover text-popover-foreground' },
    { name: 'sidebar', className: 'bg-sidebar text-sidebar-foreground' },
    { name: 'muted', className: 'bg-muted text-muted-foreground' },
    { name: 'accent', className: 'bg-accent text-accent-foreground' },
    { name: 'secondary', className: 'bg-secondary text-secondary-foreground' },
    { name: 'primary', className: 'bg-primary text-primary-foreground' },
];
const MEANINGS = [
    { name: 'success', words: 'Saved', className: 'bg-success text-success-foreground' },
    { name: 'warning', words: 'Waiting for review', className: 'bg-warning text-foreground' },
    { name: 'destructive', words: 'Could not save', className: 'bg-destructive text-destructive-foreground' },
];
const CATEGORIES = [
    { name: 'red', className: 'bg-cat-red' },
    { name: 'amber', className: 'bg-cat-amber' },
    { name: 'green', className: 'bg-cat-green' },
    { name: 'blue', className: 'bg-cat-blue' },
    { name: 'purple', className: 'bg-cat-purple' },
    { name: 'teal', className: 'bg-cat-teal' },
    { name: 'pink', className: 'bg-cat-pink' },
    { name: 'gray', className: 'bg-cat-gray' },
];
const BUTTON_VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const BUTTON_SIZES = ['lg', 'default', 'sm', 'xs'] as const;
const ICON_SIZES = ['icon', 'icon-sm', 'icon-xs'] as const;

// One part of the gallery: a heading named after the primitive or the token family, then its examples.
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <section aria-labelledby={`ui-gallery-${id}`} className="flex flex-col gap-3">
            <h2 id={`ui-gallery-${id}`} className="text-base font-semibold">{title}</h2>
            {children}
        </section>
    );
}

// A row of examples with a small label in front, the state it shows.
function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function Tokens() {
    return (
        <>
            <Section id="text" title="Text sizes">
                <div className="flex flex-col gap-1.5">
                    {TEXT_SIZES.map(size => (
                        <div key={size.name} className="flex items-baseline gap-3">
                            <span className="w-28 shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{size.name} · {size.px}</span>
                            <span className={size.className}>The quick brown fox jumps over the lazy dog</span>
                        </div>
                    ))}
                </div>
            </Section>
            <Section id="colors" title="Colors">
                <Row label="Surfaces">
                    {SURFACES.map(token => <span key={token.name} className={`rounded-md border px-3 py-2 text-xs font-medium ${token.className}`}>{token.name}</span>)}
                </Row>
                <Row label="Meaning">
                    {MEANINGS.map(token => <span key={token.name} className={`rounded-md px-3 py-2 text-xs font-medium ${token.className}`}>{token.name}: {token.words}</span>)}
                </Row>
                <Row label="Categories">
                    {CATEGORIES.map(cat => (
                        <span key={cat.name} className="flex items-center gap-1.5 text-xs">
                            <span className={`size-4 rounded-full ${cat.className}`} aria-hidden="true" />{cat.name}
                        </span>
                    ))}
                </Row>
            </Section>
        </>
    );
}

function Buttons() {
    return (
        <Section id="buttons" title="Button and IconButton">
            {BUTTON_VARIANTS.map(variant => (
                <Row key={variant} label={variant}>
                    {BUTTON_SIZES.map(size => <Button key={size} variant={variant} size={size}>{size === 'default' ? 'Default' : size}</Button>)}
                    <Button variant={variant} size="sm"><Icon name="document-new" />With icon</Button>
                    <Button variant={variant} size="sm" disabled>Disabled</Button>
                </Row>
            ))}
            <Row label="IconButton">
                {ICON_SIZES.map(size => <IconButton key={size} size={size} label={`Search (${size})`} shortcut="Ctrl+Shift+F"><Icon name="search" /></IconButton>)}
                <IconButton variant="outline" label="Settings"><Icon name="emblem-system" /></IconButton>
                <IconButton label="Pressed" aria-pressed={true}><Icon name="sidebar-show" /></IconButton>
                <IconButton label="Disabled" disabled><Icon name="edit-clear" /></IconButton>
            </Row>
        </Section>
    );
}

function Labels() {
    return (
        <Section id="badges" title="Badge and Kbd">
            <Row label="Badge">
                <Badge>default</Badge>
                <Badge variant="secondary">secondary</Badge>
                <Badge variant="outline">outline</Badge>
                <Badge variant="destructive">destructive</Badge>
            </Row>
            <Row label="Option">
                {CATEGORIES.slice(0, 4).map(cat => (
                    <Badge key={cat.name} variant="outline"><span className={`size-2 rounded-full ${cat.className}`} aria-hidden="true" />{cat.name}</Badge>
                ))}
            </Row>
            <Row label="Kbd">
                <Kbd>Ctrl+K</Kbd><Kbd>Ctrl+Shift+P</Kbd><Kbd>Esc</Kbd>
            </Row>
        </Section>
    );
}

function Entries() {
    return (
        <Section id="entries" title="Input, Textarea, InputGroup, Label">
            <div className="grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ui-gallery-name">Name</Label>
                    <Input id="ui-gallery-name" placeholder="A placeholder" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ui-gallery-filled">Filled</Label>
                    <Input id="ui-gallery-filled" defaultValue="Release plan" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ui-gallery-disabled">Disabled</Label>
                    <Input id="ui-gallery-disabled" defaultValue="Cannot change" disabled />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="ui-gallery-invalid">With an error</Label>
                    <Input id="ui-gallery-invalid" defaultValue="notes/../x" aria-invalid={true} aria-describedby="ui-gallery-invalid-error" />
                    <span id="ui-gallery-invalid-error" role="alert" className="text-xs text-destructive">A name cannot leave the folder. Pick a name without “..”.</span>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="ui-gallery-search">Search entry</Label>
                    <InputGroup>
                        <InputGroupAddon><Icon name="search" /></InputGroupAddon>
                        <InputGroupInput id="ui-gallery-search" placeholder="Search in files" />
                        <InputGroupAddon align="inline-end">
                            <InputGroupButton aria-label="Match Case" aria-pressed={true}>Aa</InputGroupButton>
                            <InputGroupButton aria-label="Whole Word">ab</InputGroupButton>
                        </InputGroupAddon>
                    </InputGroup>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor="ui-gallery-note">Note</Label>
                    <Textarea id="ui-gallery-note" placeholder="Write a note for the agent" />
                </div>
            </div>
        </Section>
    );
}

function Choices() {
    const [kind, setKind] = useState('board');
    return (
        <Section id="choices" title="Checkbox, Switch, RadioGroup, Select, Toggle">
            <Row label="Checkbox">
                <Label className="font-normal"><Checkbox />Unchecked</Label>
                <Label className="font-normal"><Checkbox defaultChecked />Checked</Label>
                <Label className="font-normal"><Checkbox disabled />Disabled</Label>
            </Row>
            <Row label="Switch">
                <Label className="font-normal"><Switch />Off</Label>
                <Label className="font-normal"><Switch defaultChecked />On</Label>
                <Label className="font-normal"><Switch disabled />Disabled</Label>
            </Row>
            <Row label="Radio">
                <RadioGroup defaultValue="all" className="flex gap-4" aria-label="Which changes">
                    <Label className="font-normal"><RadioGroupItem value="all" />All changes</Label>
                    <Label className="font-normal"><RadioGroupItem value="some" />Some</Label>
                    <Label className="font-normal"><RadioGroupItem value="none" disabled />Disabled</Label>
                </RadioGroup>
            </Row>
            <Row label="Select">
                <Select value={kind} onChange={e => setKind(e.target.value)} aria-label="Layout" className="w-40">
                    <option value="board">Board</option>
                    <option value="table">Table</option>
                    <option value="list">List</option>
                </Select>
                <Select value="" onChange={() => {}} aria-label="Empty choice" className="w-40">
                    <option value="">None</option>
                    <option value="a">A</option>
                </Select>
                <Select value="board" onChange={() => {}} aria-label="Disabled choice" disabled className="w-40"><option value="board">Disabled</option></Select>
            </Row>
            <Row label="ToggleGroup">
                <ToggleGroup type="single" defaultValue="board" variant="outline" size="sm" aria-label="Layout choice">
                    <ToggleGroupItem value="board">Board</ToggleGroupItem>
                    <ToggleGroupItem value="table">Table</ToggleGroupItem>
                    <ToggleGroupItem value="list">List</ToggleGroupItem>
                </ToggleGroup>
                <ToggleGroup type="multiple" defaultValue={['case']} size="xs" aria-label="Search options">
                    <ToggleGroupItem value="case" aria-label="Match Case">Aa</ToggleGroupItem>
                    <ToggleGroupItem value="word" aria-label="Whole Word">ab</ToggleGroupItem>
                    <ToggleGroupItem value="regex" aria-label="Regular Expression">.*</ToggleGroupItem>
                </ToggleGroup>
                <Toggle variant="outline" size="sm" aria-label="Bold" defaultPressed><Icon name="format-bold" /></Toggle>
            </Row>
        </Section>
    );
}

function Overlays() {
    const [wrap, setWrap] = useState(true);
    return (
        <Section id="overlays" title="Menus, Toast, Popover, Tooltip, Dialog, AlertDialog">
            <Row label="Menus">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Dropdown menu<Icon name="pan-down" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent className="min-w-56">
                        <DropdownMenuLabel>Document</DropdownMenuLabel>
                        <DropdownMenuItem><Icon name="document-new" />New Document<DropdownMenuShortcut>Ctrl+N</DropdownMenuShortcut></DropdownMenuItem>
                        <DropdownMenuItem disabled>Disabled item</DropdownMenuItem>
                        <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>Wrap lines</DropdownMenuCheckboxItem>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent><DropdownMenuItem>Today</DropdownMenuItem><DropdownMenuItem>Later</DropdownMenuItem></DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive"><Icon name="edit-clear" />Move to Trash</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <Menubar>
                    <MenubarMenu>
                        <MenubarTrigger>File</MenubarTrigger>
                        <MenubarContent>
                            <MenubarItem>Open File…<MenubarShortcut>Ctrl+O</MenubarShortcut></MenubarItem>
                            <MenubarSeparator />
                            <MenubarItem>Quit<MenubarShortcut>Ctrl+Q</MenubarShortcut></MenubarItem>
                        </MenubarContent>
                    </MenubarMenu>
                    <MenubarMenu><MenubarTrigger>Edit</MenubarTrigger><MenubarContent><MenubarItem>Undo</MenubarItem></MenubarContent></MenubarMenu>
                </Menubar>
                <ContextMenu>
                    <ContextMenuTrigger className="rounded-md border border-dashed px-4 py-2 text-xs text-muted-foreground">Right-click here</ContextMenuTrigger>
                    <ContextMenuContent>
                        <ContextMenuItem>Rename<ContextMenuShortcut>F2</ContextMenuShortcut></ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="destructive">Delete</ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            </Row>
            <Row label="Toast">
                <Button variant="outline" size="sm" onClick={() => toast('The note is saved')}>A notice</Button>
                <Button variant="outline" size="sm" onClick={() => toast('The card moved to Done', { action: { label: 'Undo', onClick: () => {} } })}>With an action</Button>
            </Row>
            <Row label="Floating">
                <Popover>
                    <PopoverTrigger asChild><Button variant="outline" size="sm">Popover</Button></PopoverTrigger>
                    <PopoverContent className="flex flex-col gap-2">
                        <Label htmlFor="ui-gallery-popover">Link</Label>
                        <Input id="ui-gallery-popover" placeholder="https://" />
                    </PopoverContent>
                </Popover>
                <IconButton variant="outline" label="Tooltip on hover and focus" shortcut="Ctrl+Shift+A"><Icon name="chat-message-new" /></IconButton>
                <Dialog>
                    <DialogTrigger asChild><Button variant="outline" size="sm">Dialog</Button></DialogTrigger>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>New Board</DialogTitle>
                            <DialogDescription>A task in its own window, such as a form.</DialogDescription>
                        </DialogHeader>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="ui-gallery-dialog-name">Name</Label>
                            <Input id="ui-gallery-dialog-name" defaultValue="Sprint 12" />
                        </div>
                        <DialogFooter><Button>Create Board</Button></DialogFooter>
                    </DialogContent>
                </Dialog>
                <AlertDialog>
                    <AlertDialogTrigger asChild><Button variant="outline" size="sm">AlertDialog</Button></AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Discard the changes to “plan.md”?</AlertDialogTitle>
                            <AlertDialogDescription>The changes since the last save are lost.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction variant="destructive">Discard Changes</AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </Row>
        </Section>
    );
}

// The Command as it stands in a page: the palette opens it in a Dialog (Ctrl+Shift+P).
function Commands() {
    return (
        <Section id="command" title="Command">
            <Command className="max-w-md rounded-lg border shadow-md">
                <CommandInput placeholder="Type a command or search…" aria-label="Command" />
                <CommandList>
                    <CommandEmpty>No matching commands</CommandEmpty>
                    <CommandGroup heading="Format">
                        <CommandItem>Bold<CommandShortcut><Kbd>Ctrl+B</Kbd></CommandShortcut></CommandItem>
                        <CommandItem>Italic<CommandShortcut><Kbd>Ctrl+I</Kbd></CommandShortcut></CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="File">
                        <CommandItem>Save<CommandShortcut><Kbd>Ctrl+S</Kbd></CommandShortcut></CommandItem>
                        <CommandItem disabled>Close Other Tabs</CommandItem>
                    </CommandGroup>
                </CommandList>
            </Command>
        </Section>
    );
}

function Containers() {
    const [open, setOpen] = useState(true);
    return (
        <Section id="containers" title="Tabs, Card, Collapsible, Separator">
            <Tabs defaultValue="general" className="max-w-xl">
                <TabsList>
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="editor">Editor</TabsTrigger>
                    <TabsTrigger value="agents" disabled>Disabled</TabsTrigger>
                </TabsList>
                <TabsContent value="general" className="text-sm text-muted-foreground">The first page of a dialog.</TabsContent>
                <TabsContent value="editor" className="text-sm text-muted-foreground">The second page.</TabsContent>
            </Tabs>
            <Card className="max-w-sm">
                <CardHeader>
                    <CardTitle>Write the release notes</CardTitle>
                    <CardDescription>A board card or an agent's proposal.</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-1.5">
                    <Badge variant="outline"><span className="size-2 rounded-full bg-cat-blue" aria-hidden="true" />docs</Badge>
                    <Badge variant="secondary">Due Friday</Badge>
                </CardContent>
                <CardFooter className="gap-2"><Button size="sm">Apply</Button><Button variant="outline" size="sm">Discard</Button></CardFooter>
            </Card>
            <Collapsible open={open} onOpenChange={setOpen} className="flex max-w-sm flex-col gap-1.5">
                <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="xs" className="justify-start text-2xs font-semibold uppercase tracking-wider text-muted-foreground aria-expanded:bg-transparent text-left">
                        <Icon name={open ? 'pan-down' : 'pan-end'} size={14} />Recent
                    </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-1 pl-6 text-ui">
                    <span>plan.md</span><span>journal/2026-10-25.md</span>
                </CollapsibleContent>
            </Collapsible>
            <div className="flex h-6 max-w-sm items-center gap-3 text-xs text-muted-foreground">
                <span>Before</span><Separator orientation="vertical" /><span>Between</span><Separator orientation="vertical" /><span>After</span>
            </div>
            <Separator className="max-w-sm" />
        </Section>
    );
}

function Patterns() {
    return (
        <Section id="patterns" title="Status, working, empty, error">
            <Row label="Status">
                <span role="status" className="flex items-center gap-1.5 text-xs"><Icon name="emblem-ok" size={14} className="text-success" />Saved</span>
                <span role="status" className="flex items-center gap-1.5 text-xs"><span className="size-2 rounded-full bg-warning" aria-hidden="true" />Unsaved</span>
                <Badge variant="destructive">Late</Badge>
            </Row>
            <Row label="Working">
                <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Sending…</span>
                <Button size="sm" disabled><Spinner />Pushing…</Button>
            </Row>
            <Row label="Empty">
                <p className="text-sm text-muted-foreground">No notes yet. Add one with + New note.</p>
            </Row>
            <Row label="Error">
                <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
                    <Icon name="dialog-error" size={14} />Could not push: the remote has new commits. Pull, then push again.
                </p>
            </Row>
        </Section>
    );
}

export function UiGallery({ onClose }: { onClose: () => void }) {
    const client = useClient();
    const s = useStore();
    const scheme = s.settings['color-scheme'];
    const dark = scheme === 'dark' || (scheme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const sample = window.markwork.uiGallerySample;
    // The sample is a fresh copy each time (main.ts), so the gallery steps aside for it.
    const openSample = async () => {
        const path = await sample?.();
        if (!path) return;
        client.openRecent(path);
        onClose();
    };
    return (
        <div role="region" aria-label="UI Gallery" className="fixed inset-0 z-(--z-screen) flex flex-col bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
                <h1 className="text-lg font-semibold">UI Gallery</h1>
                <span className="text-xs text-muted-foreground">Dev mode · the primitives of ui/ and the tokens, as docs/design/ui.md names them</span>
                <span className="flex-1" />
                <ToggleGroup type="single" variant="outline" size="sm" value={dark ? 'dark' : 'light'} aria-label="Theme"
                    onValueChange={value => { if (value) client.run('dark', value === 'dark'); }}>
                    <ToggleGroupItem value="light">Light</ToggleGroupItem>
                    <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
                <Button variant="outline" size="sm" disabled={!sample} onClick={() => void openSample()}>
                    <Icon name="text-x-generic" />Open Sample Document
                </Button>
                <IconButton label="Close UI Gallery" shortcut="Ctrl+Alt+G" onClick={onClose}><Icon name="window-close" /></IconButton>
            </header>
            <div className="flex-1 overflow-auto">
                <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4">
                    <Tokens />
                    <Buttons />
                    <Labels />
                    <Entries />
                    <Choices />
                    <Overlays />
                    <Commands />
                    <Containers />
                    <Patterns />
                </div>
            </div>
        </div>
    );
}
