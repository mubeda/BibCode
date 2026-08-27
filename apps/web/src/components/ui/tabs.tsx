"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("flex min-w-0 flex-col gap-6", className)} {...props} />;
}

function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex w-fit items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1",
        className,
      )}
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: ComponentProps<typeof TabsPrimitive.Tab>) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "rounded-md px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors",
        "hover:text-foreground data-selected:bg-background data-selected:text-foreground data-selected:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel className={cn("flex min-w-0 flex-col gap-8", className)} {...props} />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
