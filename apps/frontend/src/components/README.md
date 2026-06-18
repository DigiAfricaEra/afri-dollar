# AfriDollar Frontend UI Component Library

Welcome to the AfriDollar Frontend UI Component Library. This folder contains a set of highly reusable, accessible, and fully typed TypeScript components built on top of React 18, Tailwind CSS, and custom web design principles.

## Core Component Directory

All reusable components are located in the `ui` folder:

- [Button](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/button.tsx) - Standard buttons for CTAs with sizes, variants, loading state, and icons.
- [Input](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/input.tsx) - Accessible text inputs with labels, errors, helper text, and left/right adornments.
- [Select](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/select.tsx) - Styled custom selection dropdown wrapping native HTML selects.
- [Modal](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/modal.tsx) - Accessible dialog modal utilizing React Portal, ESC-key exit, and focus trapping.
- [Card](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/card.tsx) - Structural card container with headers, title, body, and footer components.
- [Avatar](file:///c:/Users/USER/Desktop/afri-dollar/apps/frontend/src/components/ui/avatar.tsx) - Profile image with loading skeleton and initials gradient fallback.

---

## Component Usage & API Documentation

### 1. Button

`Button` is the primary interactive element used for actions.

```typescript
import { Button } from './ui/button';
import { CreditCard } from 'lucide-react';

// Primary Large
<Button variant="primary" size="lg" onClick={handlePayment}>
  Send Payment
</Button>

// With Left Icon & Loading State
<Button
  variant="outline"
  loading={isLoading}
  leftIcon={<CreditCard className="h-4 w-4" />}
>
  Pay Invoice
</Button>
```

#### Props

| Prop        | Type                                                           | Default     | Description                            |
| :---------- | :------------------------------------------------------------- | :---------- | :------------------------------------- |
| `variant`   | `'primary' \| 'secondary' \| 'outline' \| 'danger' \| 'ghost'` | `'primary'` | Visual style of the button.            |
| `size`      | `'sm' \| 'md' \| 'lg'`                                         | `'md'`      | Height and padding size.               |
| `loading`   | `boolean`                                                      | `false`     | Shows spinner and disables the button. |
| `leftIcon`  | `ReactNode`                                                    | `undefined` | Icon positioned before the label.      |
| `rightIcon` | `ReactNode`                                                    | `undefined` | Icon positioned after the label.       |

---

### 2. Input

`Input` handles text entry with validation helpers and accessibility tags.

```typescript
import { Input } from './ui/input';
import { DollarSign } from 'lucide-react';

<Input
  label="Amount"
  placeholder="0.00"
  type="number"
  leftAdornment={<DollarSign className="h-4 w-4" />}
  rightAdornment={<span className="text-slate-400">USDC</span>}
  error={formErrors.amount}
  required
/>
```

#### Props

| Prop             | Type        | Default     | Description                                                         |
| :--------------- | :---------- | :---------- | :------------------------------------------------------------------ |
| `label`          | `string`    | `undefined` | Label text positioned above the input.                              |
| `error`          | `string`    | `undefined` | Validation error message (renders input with red border).           |
| `helperText`     | `string`    | `undefined` | Description text rendered below the input when no error is present. |
| `leftAdornment`  | `ReactNode` | `undefined` | Inline element or icon aligned to the left of the field.            |
| `rightAdornment` | `ReactNode` | `undefined` | Inline element or icon aligned to the right of the field.           |
| `fullWidth`      | `boolean`   | `true`      | Expands input width to 100% of container.                           |

---

### 3. Select

`Select` provides selection dropdowns using native accessibility properties with custom styles.

```typescript
import { Select } from './ui/select';

const currencyOptions = [
  { value: 'USD', label: 'US Dollar (USDC)' },
  { value: 'NGN', label: 'Nigerian Naira (NGNX)' },
  { value: 'KES', label: 'Kenyan Shilling (KESX)' },
];

<Select
  label="Destination Currency"
  options={currencyOptions}
  onChange={(e) => setCurrency(e.target.value)}
  error={formErrors.currency}
/>
```

#### Props

| Prop         | Type             | Default     | Description                                    |
| :----------- | :--------------- | :---------- | :--------------------------------------------- |
| `options`    | `SelectOption[]` | `[]`        | Array of `{ value, label, disabled }` options. |
| `label`      | `string`         | `undefined` | Select label text.                             |
| `error`      | `string`         | `undefined` | Error text to display under input.             |
| `helperText` | `string`         | `undefined` | Helper text to display under input.            |
| `fullWidth`  | `boolean`        | `true`      | Expands width to 100% of container.            |

---

### 4. Modal

`Modal` is a portal-rendered accessible dialogue overlay.

```typescript
import { useState } from 'react';
import { Modal, ModalHeader, ModalTitle, ModalBody, ModalFooter } from './ui/modal';
import { Button } from './ui/button';

export function ConfirmPaymentModal() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setIsOpen(true)}>Open Confirmation</Button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} ariaLabelledBy="modal-title">
        <ModalHeader>
          <ModalTitle id="modal-title">Confirm Transfer</ModalTitle>
        </ModalHeader>
        <ModalBody>
          Are you sure you want to transfer 1,000 USDC? This action is irreversible.
        </ModalBody>
        <ModalFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={handleConfirm}>Confirm</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}
```

#### Props

| Prop                  | Type                                     | Default     | Description                                                 |
| :-------------------- | :--------------------------------------- | :---------- | :---------------------------------------------------------- |
| `isOpen`              | `boolean`                                | required    | Sets modal visibility state.                                |
| `onClose`             | `() => void`                             | required    | Callback triggered on escape key or backdrop overlay click. |
| `size`                | `'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | `'md'`      | Max width size of the dialog.                               |
| `closeOnOverlayClick` | `boolean`                                | `true`      | Enables closing the modal by clicking outside.              |
| `closeOnEsc`          | `boolean`                                | `true`      | Enables closing by pressing the Escape key.                 |
| `ariaLabelledBy`      | `string`                                 | `undefined` | Associated title element ID for ARIA compliance.            |

---

### 5. Card

`Card` is a container element used to display structured information.

```typescript
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './ui/card';
import { Button } from './ui/button';

<Card hoverable className="max-w-sm">
  <CardHeader>
    <CardTitle>Stellar Wallet Balance</CardTitle>
    <CardDescription>Horizon Account: GD73...4K19</CardDescription>
  </CardHeader>
  <CardContent>
    <div className="text-3xl font-bold text-primary-600">54,320.50 USDC</div>
  </CardContent>
  <CardFooter>
    <Button className="w-full">Withdraw</Button>
  </CardFooter>
</Card>
```

#### Props

| Prop        | Type      | Default | Description                                                 |
| :---------- | :-------- | :------ | :---------------------------------------------------------- |
| `hoverable` | `boolean` | `false` | Enables shadow hover transition and translation animations. |

---

### 6. Avatar

`Avatar` displays profile photos or name initials with gradient backgrounds.

```typescript
import { Avatar } from './ui/avatar';

// Image loading with skeleton placeholder
<Avatar src="https://images.unsplash.com/photo-1534528741775-53994a69daeb" size="lg" />

// Initials Fallback (generates "JD" with gradient backdrop)
<Avatar name="Jane Doe" size="md" />
```

#### Props

| Prop         | Type                                   | Default     | Description                                                       |
| :----------- | :------------------------------------- | :---------- | :---------------------------------------------------------------- |
| `src`        | `string`                               | `undefined` | Target image URL source.                                          |
| `name`       | `string`                               | `""`        | User full name (used to calculate fallback initials).             |
| `size`       | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl'` | `'md'`      | Circle diameter preset.                                           |
| `fallbackBg` | `string`                               | `undefined` | Custom styling class to override the dynamic name-based gradient. |
