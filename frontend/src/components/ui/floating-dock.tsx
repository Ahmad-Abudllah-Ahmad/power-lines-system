import { cn } from "../../lib/utils";
import { IconLayoutNavbarCollapse } from "@tabler/icons-react";
import {
  AnimatePresence,
  type MotionValue,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import React, { useRef, useState } from "react";
import { NavLink } from "react-router-dom";

export type FloatingDockItem = {
  title: string;
  icon: React.ReactNode;
  href: string;
  end?: boolean;
};

export function FloatingDock({
  items,
  desktopClassName,
  mobileClassName,
}: {
  items: FloatingDockItem[];
  desktopClassName?: string;
  mobileClassName?: string;
}) {
  return (
    <>
      <div className="pointer-events-none fixed bottom-6 left-0 right-0 z-[60] hidden justify-center md:flex">
        <FloatingDockDesktop items={items} className={cn("pointer-events-auto", desktopClassName)} />
      </div>
      <div className="pointer-events-none fixed bottom-5 left-0 right-0 z-[60] flex justify-center md:hidden">
        <FloatingDockMobile items={items} className={cn("pointer-events-auto", mobileClassName)} />
      </div>
    </>
  );
}

function FloatingDockMobile({
  items,
  className,
}: {
  items: FloatingDockItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <AnimatePresence>
        {open && (
          <motion.div
            layoutId="nav"
            className="absolute inset-x-0 bottom-full mb-2 flex flex-col items-center gap-2"
          >
            {items.map((item, idx) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 10 }}
                animate={{
                  opacity: 1,
                  y: 0,
                }}
                exit={{
                  opacity: 0,
                  y: 10,
                  transition: {
                    delay: idx * 0.05,
                  },
                }}
                transition={{ delay: (items.length - 1 - idx) * 0.05 }}
              >
                <NavLink
                  to={item.href}
                  end={item.end}
                  onClick={() => setOpen(false)}
                  className="dock-item-surface flex h-10 w-10 items-center justify-center rounded-full border"
                >
                  <div className="h-5 w-5 flex items-center justify-center [&_svg]:size-5">{item.icon}</div>
                </NavLink>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="dock-fab flex h-10 w-10 items-center justify-center rounded-full border"
        aria-label={open ? "Close menu" : "Open menu"}
      >
        <IconLayoutNavbarCollapse className="h-5 w-5 text-[var(--dock-menu-icon)]" />
      </button>
    </div>
  );
}

function FloatingDockDesktop({
  items,
  className,
}: {
  items: FloatingDockItem[];
  className?: string;
}) {
  const mouseX = useMotionValue(Infinity);
  return (
    <motion.div
      onMouseMove={(e) => mouseX.set(e.pageX)}
      onMouseLeave={() => mouseX.set(Infinity)}
      className={cn(
        "dock-shell mx-auto flex h-16 items-end gap-4 rounded-2xl border px-4 pb-3 shadow-xl backdrop-blur-sm",
        className,
      )}
    >
      {items.map((item) => (
        <IconContainer mouseX={mouseX} key={item.title} {...item} />
      ))}
    </motion.div>
  );
}

function IconContainer({
  mouseX,
  title,
  icon,
  href,
  end,
}: {
  mouseX: MotionValue<number>;
  title: string;
  icon: React.ReactNode;
  href: string;
  end?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const distance = useTransform(mouseX, (val) => {
    const bounds = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 };
    return val - bounds.x - bounds.width / 2;
  });

  const widthTransform = useTransform(distance, [-150, 0, 150], [40, 80, 40]);
  const heightTransform = useTransform(distance, [-150, 0, 150], [40, 80, 40]);

  const widthTransformIcon = useTransform(distance, [-150, 0, 150], [20, 40, 20]);
  const heightTransformIcon = useTransform(distance, [-150, 0, 150], [20, 40, 20]);

  const width = useSpring(widthTransform, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });
  const height = useSpring(heightTransform, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });

  const widthIcon = useSpring(widthTransformIcon, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });
  const heightIcon = useSpring(heightTransformIcon, {
    mass: 0.1,
    stiffness: 150,
    damping: 12,
  });

  const [hovered, setHovered] = useState(false);

  return (
    <NavLink
      to={href}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-end rounded-full p-0.5",
          isActive && "ring-2 ring-cyan-500/50 ring-offset-2 ring-offset-[var(--dock-ring-offset)]",
        )
      }
    >
      <motion.div
        ref={ref}
        style={{ width, height }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="dock-item-surface relative flex aspect-square items-center justify-center rounded-full border"
      >
        <AnimatePresence>
          {hovered && (
            <motion.div
              initial={{ opacity: 0, y: 10, x: "-50%" }}
              animate={{ opacity: 1, y: 0, x: "-50%" }}
              exit={{ opacity: 0, y: 2, x: "-50%" }}
              className="dock-tooltip-surface absolute -top-8 left-1/2 w-fit rounded-md border px-2 py-0.5 text-xs whitespace-pre"
            >
              {title}
            </motion.div>
          )}
        </AnimatePresence>
        <motion.div
          style={{ width: widthIcon, height: heightIcon }}
          className="flex items-center justify-center [&_svg]:max-h-full [&_svg]:max-w-full"
        >
          {icon}
        </motion.div>
      </motion.div>
    </NavLink>
  );
}
