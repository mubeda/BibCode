/**
 * The node views an extension has on screen, handed to React as one snapshot for every view a
 * load or a transaction adds or removes, not one per view, and none once the editor is destroyed.
 */
export function createNodeViewSet<View>(onViewsChange?: (views: readonly View[]) => void) {
  const views = new Set<View>();
  let scheduled = false;
  let destroyed = false;
  const publish = () => {
    if (!onViewsChange || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!destroyed) onViewsChange([...views]);
    });
  };
  return {
    add(view: View) {
      views.add(view);
      publish();
    },
    delete(view: View) {
      views.delete(view);
      publish();
    },
    destroy() {
      destroyed = true;
    },
  };
}
