import type { TeactNode } from '../../lib/teact/teact';
import {
  memo, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { ApiCountry } from '../../api/types';

import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../../util/captureKeyboardListeners';
import { isoToEmoji } from '../../util/emoji/emoji';
import renderText from './helpers/renderText';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';
import usePreviousDeprecated from '../../hooks/usePreviousDeprecated';
import useUniqueId from '../../hooks/useUniqueId';

import Button from '../ui/Button';
import ItemPicker from './pickers/ItemPicker';
import Modal, {
  ModalCloseButton,
  ModalFooterActions,
  ModalHeader,
  ModalTitle,
} from '@gili/modal/Modal';

import styles from './CountryPickerModal.module.scss';

export type OwnProps = {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (value: string[]) => void;
  countryList: ApiCountry[];
  title: TeactNode;
  initialSelectedCountryIds?: string[];
  selectionLimit?: number | undefined;
  emptySelectionMessage?: string;
  onSelectionLimit?: (selectionLimit: number) => void;
};

const CountryPickerModal = ({
  isOpen,
  onClose,
  onSubmit,
  countryList,
  title,
  initialSelectedCountryIds,
  selectionLimit,
  emptySelectionMessage,
  onSelectionLimit,
}: OwnProps) => {
  const { showNotification } = getActions();

  const lang = useLang();
  const searchInputId = useUniqueId();

  const [selectedCountryIds, setSelectedCountryIds] = useState<string[]>([]);
  const [filterValue, setFilterValue] = useState('');
  const prevSelectedCountryIds = usePreviousDeprecated(selectedCountryIds);
  const noPickerScrollRestore = prevSelectedCountryIds === selectedCountryIds;
  const ariaLabel = typeof title === 'string' ? title : undefined;

  const displayedIds = useMemo(() => {
    if (!countryList) {
      return [];
    }

    const normalizedFilter = filterValue.trim().toLowerCase();

    return countryList.filter((country) => {
      if (country.isHidden) {
        return false;
      }

      if (!normalizedFilter) {
        return true;
      }

      return country.defaultName.toLowerCase().includes(normalizedFilter)
        || country.name?.toLowerCase().includes(normalizedFilter)
        || country.iso2.toLowerCase().includes(normalizedFilter);
    })
      .map(({
        iso2, defaultName,
      }) => ({
        value: iso2,
        label: renderText(`${isoToEmoji(iso2)} ${defaultName}`),
      }));
  }, [countryList, filterValue]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setSelectedCountryIds(initialSelectedCountryIds || []);
    setFilterValue('');
  }, [initialSelectedCountryIds, isOpen]);

  const handleSelectedIdsChange = useLastCallback((newSelectedIds: string[]) => {
    if (selectionLimit !== undefined && newSelectedIds.length > selectionLimit) {
      onSelectionLimit?.(selectionLimit);
      return;
    }
    setSelectedCountryIds(newSelectedIds);
  });

  const handleSubmit = useLastCallback(() => {
    if (emptySelectionMessage && !selectedCountryIds.length) {
      showNotification({ message: emptySelectionMessage });
      return;
    }

    onSubmit(selectedCountryIds);
    onClose();
  });

  const handleEnter = useLastCallback((event: KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : undefined;
    const dialog = document.getElementById(searchInputId)?.closest('dialog');
    if (!target || !dialog?.contains(target)) return false;
    if (target.closest('button, a[href], input[type=checkbox], input[type=radio], select, '
      + '[role=button], [role=checkbox], [role=radio], [role=option], .MenuItem')) {
      return ALLOW_KEYBOARD_EVENT_PROPAGATION;
    }
    event.preventDefault();
    if (!event.repeat) handleSubmit();
    return true;
  });

  const handleEsc = useLastCallback((event: KeyboardEvent) => {
    event.preventDefault();
    onClose();
  });

  useEffect(() => (
    isOpen ? captureKeyboardListeners({ onEnter: handleEnter, onEsc: handleEsc }) : undefined
  ), [handleEnter, handleEsc, isOpen]);

  const header = useMemo(() => (
    <ModalHeader noMask>
      <ModalCloseButton />
      <ModalTitle>{title}</ModalTitle>
    </ModalHeader>
  ), [title]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      header={header}
      ariaLabel={ariaLabel}
      width="slim"
    >
      <ItemPicker
        className={styles.picker}
        searchInputId={searchInputId}
        items={displayedIds}
        selectedValues={selectedCountryIds}
        onSelectedValuesChange={handleSelectedIdsChange}
        noScrollRestore={noPickerScrollRestore}
        forceRenderAllItems
        allowMultiple
        filterValue={filterValue}
        isSearchable
        withDefaultPadding
        withIslands
        onFilterChange={setFilterValue}
        itemInputType="checkbox"
      />

      <ModalFooterActions>
        <Button onClick={handleSubmit}>
          {lang('OK')}
        </Button>
      </ModalFooterActions>
    </Modal>
  );
};

export default memo(CountryPickerModal);
