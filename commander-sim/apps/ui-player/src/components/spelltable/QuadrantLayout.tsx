import type { ReactNode } from "react";

interface QuadrantLayoutProps {
  topLeft: ReactNode;
  topRight: ReactNode;
  bottomLeft: ReactNode;
  bottomRight: ReactNode;
}

/**
 * 2x2 SpellTable-style grid layout:
 *
 * ┌──────────┬──────────┐
 * │ AI North │ AI East  │
 * ├──────────┼──────────┤
 * │  Human   │ AI West  │
 * └──────────┴──────────┘
 */
export default function QuadrantLayout({
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
}: QuadrantLayoutProps) {
  return (
    <div className="grid h-full grid-cols-2 grid-rows-2 gap-1 p-1 bg-[#0d1117]">
      <div className="overflow-hidden rounded-2xl border border-white/10 shadow-xl">
        {topLeft}
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 shadow-xl">
        {topRight}
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 shadow-xl">
        {bottomLeft}
      </div>
      <div className="overflow-hidden rounded-2xl border border-white/10 shadow-xl">
        {bottomRight}
      </div>
    </div>
  );
}
