# Four scoped component corrections

Compared with exact source text captured before these four changes. Existing primitives, styles, localization and transport are unchanged.

## src/components/main/BrowserCloseConfirmationModal.tsx

Before SHA-256: `c02bade1a6d7de8aa02806d4aa18fb6024f07f83721ed65716c411761b972578`  
After SHA-256: `5d0d26ef246166f6a5d3d356e6eb913a8353ba272a4f2c343683a71403a48852`

```diff
--- src/components/main/BrowserCloseConfirmationModal.tsx (before)
+++ src/components/main/BrowserCloseConfirmationModal.tsx (after)
@@ -1,19 +1,15 @@
 import {
-  memo, useCallback, useRef, useState,
+  memo, useCallback, useState,
 } from '../../lib/teact/teact';
 import { getActions } from '../../global';
 
 import type { TabState } from '../../global/types';
 
-import buildClassName from '../../util/buildClassName';
-
-import useKeyboardListNavigation from '../../hooks/useKeyboardListNavigation';
 import useLang from '../../hooks/useLang';
 import useOldLang from '../../hooks/useOldLang';
 
-import Button from '../ui/Button';
 import Checkbox from '../ui/Checkbox';
-import Modal from '../ui/Modal';
+import ConfirmDialog from '../ui/ConfirmDialog';
 
 export type OwnProps = {
   modal: TabState['isBrowserCloseConfirmationModalOpen'];
@@ -31,8 +27,6 @@
 
   const [shouldSkipInFuture, setShouldSkipInFuture] = useState(false);
 
-  const containerRef = useRef<HTMLDivElement>();
-
   const onClose = useCallback(() => {
     closeBrowserCloseConfirmationModal({ shouldSkipInFuture });
   }, [shouldSkipInFuture]);
@@ -42,18 +36,14 @@
     closeBrowserCloseConfirmationModal({ shouldSkipInFuture });
   }, [shouldSkipInFuture]);
 
-  const handleSelectWithEnter = useCallback((index: number) => {
-    if (index === -1) confirmHandler();
-  }, [confirmHandler]);
-
-  const handleKeyDown = useKeyboardListNavigation(containerRef, isOpen, handleSelectWithEnter, '.Button');
-
   return (
-    <Modal
-      className={buildClassName('confirm')}
+    <ConfirmDialog
       title={lang('CloseBrowserTabs')}
       isOpen={isOpen}
       onClose={onClose}
+      confirmLabel={oldLang('Confirm')}
+      confirmHandler={confirmHandler}
+      confirmIsDestructive
     >
       <p>{lang('AreYouSureCloseBrowserTabs')}</p>
       <Checkbox
@@ -62,24 +52,7 @@
         checked={shouldSkipInFuture}
         onCheck={setShouldSkipInFuture}
       />
-      <div
-        className="dialog-buttons mt-2"
-        ref={containerRef}
-        onKeyDown={handleKeyDown}
-      >
-        <Button
-          className="confirm-dialog-button"
-          isText
-          onClick={confirmHandler}
-          color="danger"
-        >
-          {oldLang('Confirm')}
-        </Button>
-        <Button className="confirm-dialog-button" isText onClick={onClose}>
-          {oldLang('Cancel')}
-        </Button>
-      </div>
-    </Modal>
+    </ConfirmDialog>
   );
 };
 
```

## src/components/common/CountryPickerModal.tsx

Before SHA-256: `88ba19615312afad3560bfc346812117042a72707bd6ba4d8da8021d13560cba`  
After SHA-256: `27e88aab7c506e5702fa4ccefc63a10c7e7a5bf5589c8efd32d7d12df269fc8d`

```diff
--- src/components/common/CountryPickerModal.tsx (before)
+++ src/components/common/CountryPickerModal.tsx (after)
@@ -6,13 +6,14 @@
 
 import type { ApiCountry } from '../../api/types';
 
-import captureKeyboardListeners from '../../util/captureKeyboardListeners';
+import captureKeyboardListeners, { ALLOW_KEYBOARD_EVENT_PROPAGATION } from '../../util/captureKeyboardListeners';
 import { isoToEmoji } from '../../util/emoji/emoji';
 import renderText from './helpers/renderText';
 
 import useLang from '../../hooks/useLang';
 import useLastCallback from '../../hooks/useLastCallback';
 import usePreviousDeprecated from '../../hooks/usePreviousDeprecated';
+import useUniqueId from '../../hooks/useUniqueId';
 
 import Button from '../ui/Button';
 import ItemPicker from './pickers/ItemPicker';
@@ -51,6 +52,7 @@
   const { showNotification } = getActions();
 
   const lang = useLang();
+  const searchInputId = useUniqueId();
 
   const [selectedCountryIds, setSelectedCountryIds] = useState<string[]>([]);
   const [filterValue, setFilterValue] = useState('');
@@ -114,8 +116,16 @@
   });
 
   const handleEnter = useLastCallback((event: KeyboardEvent) => {
+    const target = event.target instanceof HTMLElement ? event.target : undefined;
+    const dialog = document.getElementById(searchInputId)?.closest('dialog');
+    if (!target || !dialog?.contains(target)) return false;
+    if (target.closest('button, a[href], input[type=checkbox], input[type=radio], select, '
+      + '[role=button], [role=checkbox], [role=radio], [role=option], .MenuItem')) {
+      return ALLOW_KEYBOARD_EVENT_PROPAGATION;
+    }
     event.preventDefault();
-    handleSubmit();
+    if (!event.repeat) handleSubmit();
+    return true;
   });
 
   const handleEsc = useLastCallback((event: KeyboardEvent) => {
@@ -144,6 +154,7 @@
     >
       <ItemPicker
         className={styles.picker}
+        searchInputId={searchInputId}
         items={displayedIds}
         selectedValues={selectedCountryIds}
         onSelectedValuesChange={handleSelectedIdsChange}
```

## src/components/common/PasswordConfirmModal.tsx

Before SHA-256: `ac0cac75ad2d1256db15356a02823ec1642cd6b837d10156a76f364642e54f96`  
After SHA-256: `a3a6bb575b9c5dd1c49a32929730bc415196de00d1c94ae82360f9127bbac692`

```diff
--- src/components/common/PasswordConfirmModal.tsx (before)
+++ src/components/common/PasswordConfirmModal.tsx (after)
@@ -49,6 +49,7 @@
   });
 
   const handleSubmit = useLastCallback(() => {
+    if (isLoading || !password.length) return;
     checkPassword({
       currentPassword: password,
       onSuccess: () => {
@@ -73,6 +74,7 @@
       confirmLabel={confirmLabel || lang('AutoDeleteConfirm')}
       confirmHandler={handleSubmit}
       confirmIsDestructive
+      isConfirmDisabled={isLoading || !password.length}
       onClose={handleClose}
     >
       <PasswordMonkey isBig isPasswordVisible={shouldShowPassword} />
```

## src/components/common/PasswordForm.tsx

Before SHA-256: `e929e9a1b706947fbe2dea62e1cbba0860aef91d78edfeb9a38cde83988de8a0`  
After SHA-256: `116830e9c77fee5560b491ee809761b1fb4d8c995381da76e026f1a5e016a9f4`

```diff
--- src/components/common/PasswordForm.tsx (before)
+++ src/components/common/PasswordForm.tsx (after)
@@ -14,6 +14,7 @@
 import useTimeout from '../../hooks/schedulers/useTimeout';
 import useAppLayout from '../../hooks/useAppLayout';
 import useLang from '../../hooks/useLang';
+import useLastCallback from '../../hooks/useLastCallback';
 
 import Button from '../ui/Button';
 import Icon from './icons/Icon';
@@ -100,6 +101,12 @@
     onChangePasswordVisibility(!isPasswordVisible);
   }
 
+  const handlePasswordVisibilityKeyDown = useLastCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
+    if (event.key !== 'Enter' && event.key !== ' ') return;
+    event.preventDefault();
+    if (!event.repeat) togglePasswordVisibility();
+  });
+
   function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
     event.preventDefault();
 
@@ -149,6 +156,7 @@
         <div
           className="div-button toggle-password"
           onClick={togglePasswordVisibility}
+          onKeyDown={handlePasswordVisibilityKeyDown}
           role="button"
           tabIndex={0}
           title={lang('AriaPasswordToggle')}
```
