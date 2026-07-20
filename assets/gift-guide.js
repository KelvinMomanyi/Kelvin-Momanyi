import { DialogComponent } from '@theme/dialog';
import { CartErrorEvent, CartLinesUpdateEvent } from '@shopify/events';
import { formatMoney } from '@theme/money-formatting';

/**
 * Normalises configured option values without changing what is displayed to a shopper.
 * This keeps the configurable bundle rule resilient to harmless casing and whitespace changes.
 * @param {string | undefined | null} value
 * @returns {string}
 */
function normaliseOptionValue(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

/**
 * Gets the cart summary from the same source Horizon's product form uses. The refresh is
 * required because the AJAX add response does not contain the normalized cart summary the
 * header/cart drawer expect when their CartLinesUpdateEvent promise resolves.
 * @returns {Promise<object>}
 */
async function getUpdatedCart() {
  const cartItems = document.querySelector('cart-items-component');

  if (cartItems && typeof cartItems.fetchCartData === 'function') {
    await customElements.whenDefined('cart-items-component');
    return cartItems.fetchCartData();
  }

  const response = await fetch(`${Theme.routes.cart_url}.json`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) throw new Error(`Failed to refresh the cart (${response.status}).`);
  return response.json();
}

/**
 * Owns a grid's hotspot controls. Dialog content is server-rendered per block so no product
 * request is needed on click; opening a hotspot only activates the matching native dialog.
 */
class GiftGuideGrid extends HTMLElement {
  connectedCallback() {
    this.addEventListener('click', this.#onHotspotClick);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this.#onHotspotClick);
  }

  /** @param {MouseEvent} event */
  #onHotspotClick = (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-gift-guide-dialog]') : null;
    if (!(button instanceof HTMLButtonElement)) return;

    const dialogId = button.dataset.giftGuideDialog;
    const dialog = dialogId ? document.getElementById(dialogId) : null;
    const controller = dialog?.closest('gift-guide-dialog');

    if (controller instanceof GiftGuideDialog) controller.open();
  };
}

/**
 * A newly authored product popup that deliberately extends Horizon's DialogComponent. This
 * retains the theme's focus trap, Escape/outside-click behavior, scroll lock, and closing animation.
 */
class GiftGuideDialog extends DialogComponent {
  requiredRefs = [
    'dialog',
    'closeButton',
    'colorSwatches',
    'sizeControl',
    'sizeTrigger',
    'sizeLabel',
    'sizeMenu',
    'sizeSelect',
    'price',
    'addButton',
    'status',
    'productData',
  ];

  #data;
  #colorIndex = -1;
  #sizeIndex = -1;
  #selectedColor = '';
  #selectedSize = '';
  #selectedVariant = null;
  #isAdding = false;

  connectedCallback() {
    super.connectedCallback();

    this.#data = this.#parseProductData();
    if (!this.#data) return;

    this.#colorIndex = this.#optionIndex('color');
    this.#sizeIndex = this.#optionIndex('size');
    this.#setInitialSelection();

    this.refs.closeButton.addEventListener('click', this.#onClose);
    this.refs.colorSwatches.addEventListener('click', this.#onColorClick);
    this.refs.sizeTrigger.addEventListener('click', this.#onSizeTrigger);
    this.refs.sizeMenu.addEventListener('click', this.#onSizeOptionClick);
    this.refs.sizeMenu.addEventListener('keydown', this.#onSizeMenuKeydown);
    this.refs.addButton.addEventListener('click', this.#onAddToCart);
    window.addEventListener('resize', this.#onViewportChange);
  }

  disconnectedCallback() {
    this.refs.closeButton?.removeEventListener('click', this.#onClose);
    this.refs.colorSwatches?.removeEventListener('click', this.#onColorClick);
    this.refs.sizeTrigger?.removeEventListener('click', this.#onSizeTrigger);
    this.refs.sizeMenu?.removeEventListener('click', this.#onSizeOptionClick);
    this.refs.sizeMenu?.removeEventListener('keydown', this.#onSizeMenuKeydown);
    this.refs.addButton?.removeEventListener('click', this.#onAddToCart);
    window.removeEventListener('resize', this.#onViewportChange);
    super.disconnectedCallback();
  }

  /** Opens the inherited native dialog API. */
  open() {
    // Recalculate on every open so a previously shown success/error message never
    // masks a sold-out selection after the dialog is reopened.
    this.#closeSizeMenu();
    this.#resolveVariant();
    this.showDialog();
  }

  /** @returns {Record<string, any> | null} */
  #parseProductData() {
    try {
      return JSON.parse(this.refs.productData.textContent || '{}');
    } catch (error) {
      console.error('[gift-guide] Product data could not be parsed.', error);
      this.#setStatus('Product information is unavailable. Please try again.', 'error');
      return null;
    }
  }

  /** @param {string} optionName */
  #optionIndex(optionName) {
    return (this.#data.options || []).findIndex(
      (option) => normaliseOptionValue(option.name) === normaliseOptionValue(optionName)
    );
  }

  /** Leaves Color and Size unselected until the shopper chooses them. */
  #setInitialSelection() {
    const initialVariant = this.#data.variants?.find((variant) => variant.available) || this.#data.variants?.[0];
    if (!initialVariant) {
      this.#setStatus('This product has no purchasable variants.', 'unavailable');
      this.refs.addButton.disabled = true;
      return;
    }

    this.#selectedColor = '';
    this.#selectedSize = '';

    this.#syncColorButtons();
    this.#populateSizes();
    this.#resolveVariant();
  }

  /** @param {MouseEvent} event */
  #onColorClick = (event) => {
    const swatch = event.target instanceof Element ? event.target.closest('[data-color-value]') : null;
    if (!(swatch instanceof HTMLButtonElement)) return;

    this.#selectedColor = swatch.dataset.colorValue || '';
    this.#syncColorButtons();
    this.#populateSizes();
    this.#resolveVariant();
  };

  #onSizeTrigger = () => {
    if (this.refs.sizeTrigger.disabled) return;

    if (this.refs.sizeMenu.hasAttribute('hidden')) {
      this.#openSizeMenu();
      this.refs.sizeTrigger.setAttribute('aria-expanded', 'true');
      const selectedOption = this.refs.sizeMenu.querySelector('[aria-selected="true"]');
      const firstOption = this.refs.sizeMenu.querySelector('[data-size-value]');
      (selectedOption || firstOption)?.focus();
    } else {
      this.#closeSizeMenu();
    }
  };

  /** @param {MouseEvent} event */
  #onSizeOptionClick = (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-size-value]') : null;
    if (!(option instanceof HTMLButtonElement)) return;

    this.#selectedSize = option.dataset.sizeValue || '';
    this.refs.sizeSelect.value = this.#selectedSize;
    this.#syncSizeControl();
    this.#closeSizeMenu();
    this.#resolveVariant();
  };

  /** @param {KeyboardEvent} event */
  #onSizeMenuKeydown = (event) => {
    if (event.key !== 'Escape') return;

    event.preventDefault();
    event.stopPropagation();
    this.#closeSizeMenu();
    this.refs.sizeTrigger.focus();
  };

  #onViewportChange = () => {
    if (!this.refs.sizeMenu.hasAttribute('hidden')) this.#positionSizeMenu();
  };

  /** Updates the visual selected state without using an unscoped product swatch component. */
  #syncColorButtons() {
    for (const button of this.refs.colorSwatches.querySelectorAll('[data-color-value]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const selected = button.dataset.colorValue === this.#selectedColor;
      button.setAttribute('aria-pressed', String(selected));
    }
  }

  /**
   * Rebuilds Size from the current colour's real variant matrix. Values are retained even
   * when sold out so a shopper gets an explicit unavailable state instead of a misleading
   * missing size option.
   */
  #populateSizes() {
    const select = this.refs.sizeSelect;

    if (this.#sizeIndex < 0) {
      select.hidden = true;
      select.closest('.gift-guide-popup__option')?.setAttribute('hidden', '');
      return;
    }

    const sizes = [];
    for (const variant of this.#data.variants || []) {
      const sameColor =
        this.#colorIndex < 0 || !this.#selectedColor || variant.options?.[this.#colorIndex] === this.#selectedColor;
      const size = variant.options?.[this.#sizeIndex];
      if (sameColor && size && !sizes.includes(size)) sizes.push(size);
    }

    if (!sizes.includes(this.#selectedSize)) this.#selectedSize = '';

    select.replaceChildren();
    const placeholder = new Option('Choose your size', '', this.#selectedSize === '', this.#selectedSize === '');
    placeholder.disabled = true;
    select.add(placeholder);

    for (const size of sizes) {
      const option = new Option(size, size, false, size === this.#selectedSize);
      select.add(option);
    }

    select.value = this.#selectedSize;
    select.disabled = sizes.length === 0;
    this.refs.sizeMenu.replaceChildren(
      ...sizes.map((size) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'gift-guide-popup__size-option';
        option.dataset.sizeValue = size;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(size === this.#selectedSize));
        option.textContent = size;
        return option;
      })
    );
    this.refs.sizeTrigger.disabled = sizes.length === 0;
    this.#syncSizeControl();
  }

  /** Keeps the custom Size control in sync with the hidden native select. */
  #syncSizeControl() {
    const hasSelection = Boolean(this.#selectedSize);
    this.refs.sizeLabel.textContent = hasSelection ? this.#selectedSize : 'Choose your size';
    this.refs.sizeTrigger.dataset.hasSelection = String(hasSelection);

    for (const option of this.refs.sizeMenu.querySelectorAll('[data-size-value]')) {
      if (!(option instanceof HTMLButtonElement)) continue;
      option.setAttribute('aria-selected', String(option.dataset.sizeValue === this.#selectedSize));
    }
  }

  /** Closes the custom Size list without changing the current selection. */
  #closeSizeMenu() {
    this.refs.sizeMenu.setAttribute('hidden', '');
    delete this.refs.sizeMenu.dataset.open;
    this.refs.sizeMenu.style.removeProperty('--gift-guide-size-menu-top');
    this.refs.sizeMenu.style.removeProperty('--gift-guide-size-menu-left');
    this.refs.sizeMenu.style.removeProperty('--gift-guide-size-menu-width');
    delete this.refs.sizeMenu.dataset.placement;
    this.refs.sizeTrigger.setAttribute('aria-expanded', 'false');
  }

  /** Opens and positions the floating list against the Size trigger. */
  #openSizeMenu() {
    const { sizeMenu, sizeTrigger } = this.refs;
    const triggerRect = sizeTrigger.getBoundingClientRect();

    sizeMenu.style.setProperty('--gift-guide-size-menu-left', `${triggerRect.left}px`);
    sizeMenu.style.setProperty('--gift-guide-size-menu-width', `${triggerRect.width}px`);
    sizeMenu.style.visibility = 'hidden';
    sizeMenu.removeAttribute('hidden');
    sizeMenu.dataset.open = 'true';
    this.#positionSizeMenu();
    sizeMenu.style.removeProperty('visibility');
  }

  /** Keeps the floating list inside the viewport when the layout changes. */
  #positionSizeMenu() {
    const { sizeMenu, sizeTrigger } = this.refs;
    const triggerRect = sizeTrigger.getBoundingClientRect();
    const menuHeight = sizeMenu.getBoundingClientRect().height;
    const viewportGap = 8;
    const spaceBelow = window.innerHeight - triggerRect.bottom - viewportGap;
    const shouldOpenAbove = menuHeight > spaceBelow && triggerRect.top - viewportGap >= menuHeight;
    const top = shouldOpenAbove ? triggerRect.top - menuHeight + 1 : triggerRect.bottom - 1;

    sizeMenu.style.setProperty('--gift-guide-size-menu-top', `${Math.max(viewportGap, top)}px`);
    sizeMenu.style.setProperty('--gift-guide-size-menu-left', `${triggerRect.left}px`);
    sizeMenu.style.setProperty('--gift-guide-size-menu-width', `${triggerRect.width}px`);
    sizeMenu.dataset.placement = shouldOpenAbove ? 'above' : 'below';
  }

  /** Finds only the variant represented by the shopper's Color/Size selections. */
  #resolveVariant() {
    const matchingVariants = (this.#data.variants || []).filter((variant) => {
      // Unselected controls intentionally behave as wildcards. This leaves the
      // first available variant purchasable while the visual controls remain in
      // their neutral reference state.
      const colorMatches =
        this.#colorIndex < 0 || !this.#selectedColor || variant.options?.[this.#colorIndex] === this.#selectedColor;
      const sizeMatches =
        this.#sizeIndex < 0 || !this.#selectedSize || variant.options?.[this.#sizeIndex] === this.#selectedSize;
      return colorMatches && sizeMatches;
    });

    this.#selectedVariant = matchingVariants.find((variant) => variant.available) || matchingVariants[0] || null;

    const variant = this.#selectedVariant;
    if (!variant) {
      this.refs.addButton.disabled = true;
      this.#setStatus('This color and size combination is unavailable.', 'unavailable');
      return;
    }

    this.refs.price.textContent = formatMoney(
      variant.price,
      this.#data.showCurrencyCode ? this.#data.moneyWithCurrencyFormat : this.#data.moneyFormat,
      this.#data.currency
    );

    this.refs.addButton.disabled = !variant.available || this.#isAdding;
    if (!variant.available) {
      this.#setStatus('This color and size is sold out.', 'unavailable');
    } else {
      this.#clearStatus();
    }
  }

  /** @returns {boolean} */
  #shouldAddBundle() {
    if (!this.#selectedVariant || !this.#data.bundleVariantId) return false;
    if (this.#colorIndex < 0 || this.#sizeIndex < 0) return false;

    return (
      normaliseOptionValue(this.#selectedVariant.options?.[this.#colorIndex]) ===
        normaliseOptionValue(this.#data.bundleTriggerColor) &&
      normaliseOptionValue(this.#selectedVariant.options?.[this.#sizeIndex]) ===
        normaliseOptionValue(this.#data.bundleTriggerSize)
    );
  }

  /** @param {MouseEvent} event */
  #onAddToCart = async (event) => {
    event.preventDefault();
    const variant = this.#selectedVariant;
    if (!variant || !variant.available || this.#isAdding) return;

    this.#isAdding = true;
    this.refs.addButton.disabled = true;
    this.#setStatus('Adding to cart…', 'loading');

    // The complete bundle is deliberately posted in one `items` payload. This avoids
    // partial bundles and fulfils the atomic single-add request business requirement.
    const items = [{ id: Number(variant.id), quantity: 1 }];
    if (this.#shouldAddBundle() && Number(this.#data.bundleVariantId) !== Number(variant.id)) {
      items.push({ id: Number(this.#data.bundleVariantId), quantity: 1 });
    }

    const sectionIds = Array.from(document.querySelectorAll('cart-items-component'))
      .map((component) => component.dataset.sectionId)
      .filter(Boolean);
    const cartUpdate = CartLinesUpdateEvent.createPromise();

    // Dispatch from the native dialog so Horizon's cart drawer knows to wait for
    // this modal to close before moving focus into the drawer.
    this.refs.dialog.dispatchEvent(
      new CartLinesUpdateEvent({
        action: 'add',
        context: 'product',
        lines: items.map((item) => ({ merchandiseId: String(item.id), quantity: item.quantity })),
        promise: cartUpdate.promise,
      })
    );

    let didAddSuccessfully = false;

    try {
      const response = await fetch(Theme.routes.cart_add_url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ items, sections: sectionIds.join(',') }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || payload.status) {
        throw new Error(payload.description || payload.message || 'Unable to add this item to the cart.');
      }

      const cart = await getUpdatedCart();
      cartUpdate.resolve({
        cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart),
        detail: {
          items: cart.items,
          sections: payload.sections,
          source: 'gift-guide-dialog',
          sourceId: this.refs.dialog.id,
          itemCount: items.reduce((total, item) => total + item.quantity, 0),
          productId: this.#data.productId,
          didError: false,
        },
      });

      this.#setStatus(items.length > 1 ? 'Both items were added to your cart.' : 'Added to your cart.', 'success');
      didAddSuccessfully = true;

      // A brief confirmation is more accessible than an immediate disappearance;
      // closing afterwards lets Horizon's existing cart drawer take focus normally.
      window.setTimeout(() => this.closeDialog(), 550);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to add this item to the cart.';
      cartUpdate.reject(error);
      this.refs.dialog.dispatchEvent(new CartErrorEvent({ error: message, code: 'SERVICE_UNAVAILABLE' }));
      this.#setStatus(message, 'error');
    } finally {
      this.#isAdding = false;
      // Keep the successful state and disabled button visible for the short
      // confirmation interval. On errors, restore normal availability instead.
      if (!didAddSuccessfully) this.#resolveVariant();
    }
  };

  #onClose = () => this.closeDialog();

  /** @param {string} message @param {'error'|'success'|'unavailable'|'loading'} state */
  #setStatus(message, state) {
    this.refs.status.textContent = message;
    this.refs.status.dataset.state = state;
  }

  #clearStatus() {
    this.refs.status.textContent = '';
    delete this.refs.status.dataset.state;
  }
}

if (!customElements.get('gift-guide-grid')) {
  customElements.define('gift-guide-grid', GiftGuideGrid);
}

if (!customElements.get('gift-guide-dialog')) {
  customElements.define('gift-guide-dialog', GiftGuideDialog);
}
