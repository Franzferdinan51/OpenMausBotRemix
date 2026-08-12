import { memo, type CSSProperties } from "react";
import { MAUS_COLORS, type MascotShape, type MausColor, type MausExpression, type MausMotion } from "@/lib/mascot";

function MausAvatarComponent({ color, shape = "orb", expression: _expression = "deadpan", size = 44, label, motion = "none", motionKey = 0 }: {
  color: MausColor; shape?: MascotShape; expression?: MausExpression; size?: number; label?: string; motion?: MausMotion; motionKey?: number;
}) {
  return <span key={motionKey} className={`maus-raster-avatar maus-raster-avatar--${motion} inline-flex shrink-0 items-center justify-center`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ width: size, height: size, "--maus-color": MAUS_COLORS[color] } as CSSProperties}>
    <img src={`/mascots/${shape}.png`} alt="" draggable={false} className="h-full w-full object-contain" />
  </span>;
}

export const MausAvatar = memo(MausAvatarComponent);

export function InitialsAvatar({ name, initials: suppliedInitials, size = 36 }: { name?: string; initials?: string; size?: number }) {
  const initials = suppliedInitials ?? (name?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?");
  return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-raised text-[11px] font-semibold text-ink" style={{ width: size, height: size }}>{initials}</span>;
}
