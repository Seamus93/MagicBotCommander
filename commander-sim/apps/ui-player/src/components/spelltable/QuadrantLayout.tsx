import type { ReactNode } from "react";

interface QuadrantLayoutProps {
  topLeft: ReactNode;
  topRight: ReactNode;
  bottomLeft: ReactNode;
  bottomRight: ReactNode;
}

export default function QuadrantLayout({
  topLeft,
  topRight,
  bottomLeft,
  bottomRight,
}: QuadrantLayoutProps) {
  return (
    <div className="relative grid h-full grid-cols-2 grid-rows-2 gap-[3px] overflow-hidden bg-[radial-gradient(circle_at_50%_50%,rgba(245,158,11,.24),transparent_9%),linear-gradient(135deg,#070a10,#15100b_48%,#05070c)] p-[3px]">
      <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_18px_42px_rgba(0,0,0,.42)]">
        {topLeft}
      </div>
      <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_18px_42px_rgba(0,0,0,.42)]">
        {topRight}
      </div>
      <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_18px_42px_rgba(0,0,0,.42)]">
        {bottomLeft}
      </div>
      <div className="overflow-hidden rounded-[18px] border border-white/10 bg-black shadow-[inset_0_1px_0_rgba(255,255,255,.08),0_18px_42px_rgba(0,0,0,.42)]">
        {bottomRight}
      </div>
    </div>
  );
}
