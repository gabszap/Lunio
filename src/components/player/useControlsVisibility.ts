import { useCallback, useRef, useState } from 'react';

/** Os controles somem 3 s depois da última interação, exceto pausado ou com um menu aberto. */
export function useControlsVisibility(paused: boolean) {
  // Controls visibility management
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const hideControlsTimeout = useRef<number | null>(null);
  // Com um menu (legendas, áudio, ajustes…) aberto os controles não somem
  const menuOpenRef = useRef<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  const resetControlsTimer = useCallback(() => {
    setControlsVisible((prev) => (prev ? prev : true));
    if (hideControlsTimeout.current) {
      window.clearTimeout(hideControlsTimeout.current);
    }
    if (!paused && !menuOpenRef.current) {
      hideControlsTimeout.current = window.setTimeout(() => {
        setControlsVisible(false);
      }, 3000);
    }
  }, [paused]);

  const handleMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpenRef.current = open;
      setMenuOpen(open);
      resetControlsTimer();
    },
    [resetControlsTimer]
  );

  return { controlsVisible, setControlsVisible, resetControlsTimer, handleMenuOpenChange, menuOpen };
}
