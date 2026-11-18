import { RibbonGroup } from '../../../RibbonGroup';
import { ColumnsButton } from './ColumnsButton';
import { LineNumbersButton } from '../LineNumbersButton';

export function ArrangeGroup() {
  return (
    <RibbonGroup showSeparator={false}>
      {/* #74 COLUMNS — live: the quick-preset popover + "More columns…"
          (the scoped dialog). */}
      <ColumnsButton />
      <LineNumbersButton />
    </RibbonGroup>
  );
}
