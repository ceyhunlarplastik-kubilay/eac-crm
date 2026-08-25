"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = {
  [key: string]: {
    label?: React.ReactNode;
    color?: string;
  };
};

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;
  const colorVars = Object.entries(config).reduce<
    React.CSSProperties & Record<string, string>
  >(
    (style, [key, item]) => {
      if (item.color) {
        style[`--color-${key}`] = item.color;
      }
      return style;
    },
    {}
  );

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn("flex aspect-video justify-center text-xs", className)}
        style={colorVars}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  labelFormatter,
  nameKey
}: React.ComponentProps<"div"> & {
  active?: boolean;
  payload?: Array<{
    name?: string;
    dataKey?: string;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
  labelFormatter?: (label: string) => React.ReactNode;
  nameKey?: string;
}) {
  const { config } = useChart();

  if (!active || !payload?.length) return null;

  return (
    <div
      className={cn(
        "grid min-w-32 gap-1.5 rounded-md border bg-background px-2.5 py-2 text-xs shadow-md",
        className
      )}
    >
      {label && (
        <div className="font-medium">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      )}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(nameKey ?? item.dataKey ?? item.name ?? "");
          const itemConfig = config[key];
          return (
            <div
              key={key}
              className="flex min-w-0 items-center justify-between gap-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: item.color ?? itemConfig?.color }}
                />
                <span className="truncate text-muted-foreground">
                  {itemConfig?.label ?? key}
                </span>
              </div>
              <span className="font-mono font-medium tabular-nums">
                {typeof item.value === "number"
                  ? item.value.toLocaleString("tr-TR")
                  : item.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  RechartsPrimitive
};
