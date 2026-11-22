import { RibbonGroup } from '../../../RibbonGroup';
import { ColumnsButton } from './ColumnsButton';
import { LineNumbersButton } from '../LineNumbersButton';

export function ArrangeGroup() {
  return (
    <RibbonGroup showSeparator={false}>
      <ColumnsButton />
      <LineNumbersButton />
    </RibbonGroup>
  );
}
