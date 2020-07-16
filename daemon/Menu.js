//////////////////////////////////////////////////////////////////////////////////////////
//   _____       _             _____ _                                                  //
//  |   __|_ _ _|_|___ ___ ___|  _  |_|___   This software may be modified and distri-  //
//  |__   | | | | |   | . |___|   __| | -_|  buted under the terms of the MIT license.  //
//  |_____|_____|_|_|_|_  |   |__|  |_|___|  See the LICENSE file for details.          //
//                    |___|                                                             //
//////////////////////////////////////////////////////////////////////////////////////////

'use strict';

const Main    = imports.ui.main;
const Clutter = imports.gi.Clutter;

const Me               = imports.misc.extensionUtils.getCurrentExtension();
const utils            = Me.imports.common.utils;
const DBusInterface    = Me.imports.common.DBusInterface.DBusInterface;
const InputManipulator = Me.imports.common.InputManipulator.InputManipulator;
const Background       = Me.imports.daemon.Background.Background;
const MenuItem         = Me.imports.daemon.MenuItem.MenuItem;
const SelectionWedges  = Me.imports.daemon.SelectionWedges.SelectionWedges;
const MenuItemState    = Me.imports.daemon.MenuItem.MenuItemState;

//////////////////////////////////////////////////////////////////////////////////////////
// The Menu parses the JSON structure given to the ShowMenu method. It creates          //
// MenuItems accordingly. It keeps a list of currently selected MenuItems and, based on //
// the selection events from the SelectionWedges, it manages the state changes of the   //
// individual MenuItems in the hierarchy.                                               //
//////////////////////////////////////////////////////////////////////////////////////////

var Menu = class Menu {

  // ------------------------------------------------------------ constructor / destructor

  // The Menu is only instantiated once by the Server. It is re-used for each new incoming
  // ShowMenu request. The three parameters are callbacks which are fired when the
  // corresponding event occurs.
  constructor(onSelect, onCancel) {

    // Create Gio.Settings object for org.gnome.shell.extensions.swingpie.
    this._settings = utils.createSettings();

    // Store the callbacks.
    this._onSelect = onSelect;
    this._onCancel = onCancel;

    // This holds the ID of the currently active menu. It's null if no menu is currently
    // shown.
    this._menuID = null;

    // True if the currently visible menu is in preview-mode.
    this._previewMode = false;

    // Stores a reference to the MenuItem which is currently dragged around while a
    // gesture is performed.
    this._draggedChild = null;

    // This is a list of active MenuItems. At the beginning it will contain the root
    // MenuItem only. Selected children deeper in the hierarchy are prepended to this
    // list. This means, the currently active menu node is always _menuSelectionChain[0].
    this._menuSelectionChain = [];

    // This is used to warp the mouse pointer at the edges of the screen if necessary.
    this._input = new InputManipulator();

    // The background covers the entire screen. Usually it's transparent and thus
    // invisible but once a menu is shown, it will be pushed as modal capturing the
    // complete user input. The color of the then visible background can be configured via
    // the settings. Input is handled by the involved classes mostly like this:
    //   .------------.     .-----------------.     .------.     .-----------.
    //   | Background | --> | SelectionWedges | --> | Menu | --> | MenuItems |
    //   '------------'     '-----------------'     '------'     '-----------'
    // The Background captures all button and motion events which are then forwarded to
    // the SelectionWedges. The SelectionWedges compute the currently active wedge and
    // emit signals indicating any change. These change events are then passed from the
    // Menu to the individual MenuItems.
    this._background = new Background();
    Main.layoutManager.addChrome(this._background);

    // Forward button release events to the SelectionWedges.
    this._background.connect('button-release-event', (actor, event) => {
      this._selectionWedges.onButtonReleaseEvent(event);
      return Clutter.EVENT_STOP;
    });

    // Forward motion events to the SelectionWedges. If the primary mouse button is
    // pressed, this will also drag the currently active child around.
    this._background.connect('motion-event', (actor, event) => {
      this._selectionWedges.onMotionEvent(event);

      // If the primary button is pressed but we don not have a dragged child yet, we mark
      // the currently hovered child as being the dragged child.
      if (event.get_state() & Clutter.ModifierType.BUTTON1_MASK &&
          this._draggedChild == null) {
        const index = this._selectionWedges.getHoveredChild();
        if (index >= 0) {
          const child = this._menuSelectionChain[0].getChildMenuItems()[index];
          child.setState(MenuItemState.CHILD_DRAGGED);
          this._draggedChild = child;
        }
      }

      // If there is a dragged child, update its position.
      if (this._draggedChild != null) {

        // Transform event coordinates to parent-relative coordinates.
        let ok, x, y;
        [x, y]       = event.get_coords();
        const parent = this._draggedChild.get_parent().get_parent();
        [ok, x, y]   = parent.transform_stage_point(x, y);

        // Set the child's position without any transition.
        this._draggedChild.set_easing_duration(0);
        this._draggedChild.set_translation(x, y, 0);

        // Draw the parent's trace to this position.
        parent.drawTrace(x, y, 0, 0);

        // This shouldn't be necessary but it reduces some severe flickering when children
        // are dragged around slowly. It almost seems as some buffers are not cleared
        // sufficiently without this...
        this._background.queue_redraw();
      }

      return Clutter.EVENT_STOP;
    });

    // Delete the currently active menu once the background was faded-out.
    this._background.connect('transitions-completed', () => {
      if (this._background.opacity == 0 && this._root) {
        this._root.destroy();
        this._root = null;
      }
    });

    // This is fired when the close button of the preview mode is clicked.
    this._background.connect('close-event', () => {
      this._onCancel(this._menuID);
      this._hide();
    });

    // All interaction with the menu happens through the SelectionWedges. They receive
    // motion and button events and emit selection signals based on this input. When these
    // signals are emitted, the state of all MenuItems is changed accordingly. For a full
    // description of the SelectionWedge have a look at their file. Here is a quick
    // summary of the signals:
    // child-hovered-event:    When the mouse pointer enters one of the wedges.
    // child-selected-event:   When the primary mouse button is pressed inside a wedge.
    // parent-hovered-event:   Same as child-hovered-event, but for the parent wedge.
    // parent-selected-event:  Same as child-selected-event, but for the parent wedge.
    // cancel-selection-event: When the secondary mouse button is pressed.
    this._selectionWedges = new SelectionWedges();
    this._background.add_child(this._selectionWedges);

    // This is fired when the mouse pointer enters one of the wedges.
    this._selectionWedges.connect('child-hovered-event', (o, index) => {
      // If no child is hovered (index == -1), the center element is hovered.
      if (index == -1) {
        this._menuSelectionChain[0].setState(MenuItemState.CENTER_HOVERED, -1);
      } else {
        this._menuSelectionChain[0].setState(MenuItemState.CENTER, index);
      }

      // It could be that the parent of the currently active item was hovered before, so
      // lets set its state back to PARENT.
      if (this._menuSelectionChain.length > 1) {
        this._menuSelectionChain[1].setState(MenuItemState.PARENT);
      }

      // If we're currently dragging a child around, the newly hovered child will
      // instantaneously become the hovered child.
      const [x, y, mods] = global.get_pointer();
      if (mods & Clutter.ModifierType.BUTTON1_MASK && index >= 0) {
        const child = this._menuSelectionChain[0].getChildMenuItems()[index];
        child.setState(MenuItemState.CHILD_DRAGGED);
        this._draggedChild = child;
      } else {
        this._draggedChild = null;
      }

      // This recursively redraws all children based on their newly assigned state.
      this._root.redraw();
    });

    // This is fired when the primary mouse button is pressed inside a wedge. This will
    // also be emitted when a gesture is detected.
    this._selectionWedges.connect('child-selected-event', (o, index) => {
      const parent = this._menuSelectionChain[0];
      const child  = this._menuSelectionChain[0].getChildMenuItems()[index];
      const root   = this._menuSelectionChain[this._menuSelectionChain.length - 1];

      const [pointerX, pointerY, mods] = global.get_pointer();

      // Ignore any gesture-based selection of leaf nodes. Final selections are only done
      // when the mouse button is released.
      if (mods & Clutter.ModifierType.BUTTON1_MASK &&
          child.getChildMenuItems().length == 0) {
        return;
      }

      // Once something is selected, it's not dragged anymore. Even if the mouse button is
      // still pressed (we might come here when a gesture was detected by the
      // SelectionWedges), we abort any dragging operation.
      this._draggedChild = null;

      // Update the item states: The previously active item becomes the parent, the
      // selected child becomes the new hovered center item.
      parent.setState(MenuItemState.PARENT, index);
      child.setState(MenuItemState.CENTER_HOVERED);

      // Prepend the newly active item to our menu selection chain.
      this._menuSelectionChain.unshift(child);

      // The newly active item will be shown at the pointer position. To prevent it from
      // going offscreen, we clamp the position to the current monitor bounds.
      const [clampedX, clampedY] = this._clampToToMonitor(pointerX, pointerY, 10);

      // Warp the mouse pointer to this position if necessary.
      if (pointerX != clampedX || pointerY != clampedY) {
        this._input.warpPointer(clampedX, clampedY);
      }

      // The "trace" of the menu needs to be "idealized". That means, even if the user did
      // not click exactly in the direction of the item, the line connecting parent and
      // child has to be drawn with the correct angle. As the newly active item will be
      // shown directly at the pointer position, we must move the parent so that the trace
      // has the correct angle. Actually not the parent item has to move but the root of
      // the entire menu selection chain.

      // This is the clamped click-position relative to the newly active item's parent.
      const [ok, relativeX, relativeY] = parent.transform_stage_point(clampedX, clampedY);

      // Compute the final trace length as max(distance-click-to-parent, min-trace-length)
      const currentTraceLength = Math.sqrt(relativeX * relativeX + relativeY * relativeY);
      const idealTraceLength   = Math.max(
          this._settings.get_double('trace-min-length') *
              this._settings.get_double('global-scale'),
          currentTraceLength);

      // Based on this trace length, we can compute where the newly active item should be
      // placed relative to its parent.
      const childAngle = child.angle * Math.PI / 180;
      const idealX     = Math.floor(Math.sin(childAngle) * idealTraceLength);
      const idealY     = -Math.floor(Math.cos(childAngle) * idealTraceLength);

      // Based on difference, we can now translate the root item.
      const requiredOffsetX = relativeX - idealX;
      const requiredOffsetY = relativeY - idealY;
      root.set_translation(
          root.translation_x + requiredOffsetX, root.translation_y + requiredOffsetY, 0);

      // The newly active item will be placed at its idealized position. As the root menu
      // moved, this will be exactly at the pointer position.
      child.set_easing_duration(this._settings.get_double('easing-duration') * 1000);
      child.set_easing_mode(this._settings.get_enum('easing-mode'));
      child.set_translation(idealX, idealY, 0);

      // Now we update position and the number of wedges of the SelectionWedges
      // according to the newly active item.
      if (child.getChildMenuItems().length > 0) {
        const itemAngles = [];
        child.getChildMenuItems().forEach(item => {
          itemAngles.push(item.angle);
        });

        this._selectionWedges.setItemAngles(itemAngles, (child.angle + 180) % 360);
        this._selectionWedges.set_translation(
            clampedX - this._background.x, clampedY - this._background.y, 0);
      }

      // This recursively redraws all children based on their newly assigned state.
      this._root.redraw();

      // Finally, if a child was selected which has no children, we report a selection and
      // hide the entire menu.
      if (child.getChildMenuItems().length == 0) {
        this._onSelect(this._menuID, child.id);
        this._background.set_easing_delay(
            this._settings.get_double('easing-duration') * 1000);
        this._hide();
        this._background.set_easing_delay(0);
      }
    });

    // When a parent item is hovered, we draw the currently active item with the state
    // CENTER_HOVERED to indicate that the parent is not a child.
    this._selectionWedges.connect('parent-hovered-event', () => {
      this._menuSelectionChain[0].setState(MenuItemState.CENTER_HOVERED, -1);
      this._menuSelectionChain[1].setState(MenuItemState.PARENT_HOVERED);

      // This recursively redraws all children based on their newly assigned state.
      this._root.redraw();

      // Parent items cannot be dragged around. Even if the mouse button is still pressed
      // (we might come here when a gesture was detected by the SelectionWedges), we abort
      // any dragging operation.
      this._draggedChild = null;
    });

    // If the parent of the currently active item is selected, it becomes the newly active
    // item with the state CENTER_HOVERED.
    this._selectionWedges.connect('parent-selected-event', () => {
      const parent = this._menuSelectionChain[1];
      parent.setState(MenuItemState.CENTER_HOVERED, -1);

      // Remove the first element of the menu selection chain.
      this._menuSelectionChain.shift();

      // The parent item will be moved to the pointer position. To prevent it from
      // going offscreen, we clamp the position to the current monitor bounds.
      const [pointerX, pointerY] = global.get_pointer();
      const [clampedX, clampedY] = this._clampToToMonitor(pointerX, pointerY, 10);

      // Warp the mouse pointer to this position if necessary.
      if (pointerX != clampedX || pointerY != clampedY) {
        this._input.warpPointer(clampedX, clampedY);
      }

      // Now we update position and the number of wedges of the SelectionWedges
      // according to the newly active item.
      const itemAngles = [];
      parent.getChildMenuItems().forEach(item => {
        itemAngles.push(item.angle);
      });

      // If necessary, add a wedge for the parent's parent.
      if (this._menuSelectionChain.length > 1) {
        this._selectionWedges.setItemAngles(itemAngles, (parent.angle + 180) % 360);
      } else {
        this._selectionWedges.setItemAngles(itemAngles);
      }

      this._selectionWedges.set_translation(
          clampedX - this._background.x, clampedY - this._background.y, 0);

      // We need to move the menu selection chain's root element so that our newly active
      // item is exactly at the pointer position.
      const [ok, relativeX, relativeY] = parent.transform_stage_point(clampedX, clampedY);
      const root         = this._menuSelectionChain[this._menuSelectionChain.length - 1];
      root.translation_x = root.translation_x + relativeX;
      root.translation_y = root.translation_y + relativeY;

      // Once the parent is selected, nothing is dragged anymore. Even if the mouse button
      // is still pressed (we might come here when a gesture was detected by the
      // SelectionWedges), we abort any dragging operation.
      this._draggedChild = null;

      // This recursively redraws all children based on their newly assigned state.
      this._root.redraw();
    });

    // This is usually fired when the right mouse button is pressed.
    this._selectionWedges.connect('cancel-selection-event', () => {
      this._onCancel(this._menuID);
      this._hide();
    });

    // Whenever settings are changed, we adapt the currently shown menu accordingly.
    this._settings.connect('change-event', this._onSettingsChange.bind(this));
    this._onSettingsChange();
  }

  // This removes our root actor from Gnome-Shell.
  destroy() {
    Main.layoutManager.removeChrome(this._background);
    this._background.destroy();
  }

  // -------------------------------------------------------------------- public interface

  // This shows the menu, blocking all user input. A subtle animation is used to fade in
  // the menu. Returns an error code if something went wrong. See DBusInerface.js for all
  // possible error codes.
  show(menuID, structure, previewMode) {

    // The menu is already active.
    if (this._menuID) {
      return DBusInterface.errorCodes.eAlreadyActive;
    }

    // Check if there is a root item list.
    if (!(structure.children && structure.children.length > 0)) {
      return DBusInterface.errorCodes.ePropertyMissing;
    }

    // Remove any previous menus.
    if (this._root) {
      this._root.destroy();
    }

    // Store the preview mode flag.
    this._previewMode = previewMode;

    // Make sure that a name and an icon is set.
    if (structure.name == undefined) {
      structure.name = 'root';
    }

    if (structure.icon == undefined) {
      structure.icon = 'image-missing';
    }

    // Calculate and verify all item angles.
    structure.angle = 0;
    if (!this._updateItemAngles(structure.children)) {
      return DBusInterface.errorCodes.eInvalidAngles;
    }

    // Assign an ID to each item.
    structure.id = '/';
    this._updateItemIDs(structure.children);

    // Try to grab the complete input.
    if (!this._background.show(previewMode)) {
      // Something went wrong while grabbing the input. Let's abort this.
      return DBusInterface.errorCodes.eUnknownError;
    }

    // Everything seems alright, start opening the menu!
    this._menuID = menuID;

    // Create all visible Clutter.Actors for the items.
    const createMenuItem = (item) => {
      const menuItem = new MenuItem(
          {id: item.id, caption: item.name, icon: item.icon, angle: item.angle});

      if (item.children) {
        item.children.forEach(child => {
          menuItem.addMenuItem(createMenuItem(child));
        });
      }
      return menuItem;
    };

    this._root = createMenuItem(structure);
    this._background.add_child(this._root);

    this._menuSelectionChain.push(this._root);

    this._root.setState(MenuItemState.CENTER_HOVERED, -1);
    this._root.onSettingsChange(this._settings);
    this._root.redraw();

    // Initialize the wedge angles of the SelectionWedges according to the root menu.
    const itemAngles = [];
    this._root.getChildMenuItems().forEach(item => {
      itemAngles.push(item.angle);
    });
    this._selectionWedges.setItemAngles(itemAngles);

    // Calculate menu position. In preview mode, we center the menu, else we position it
    // at the mouse pointer.
    if (previewMode) {
      this._root.set_translation(
          this._background.width / 2, this._background.height / 2, 0);
      this._selectionWedges.set_translation(
          this._background.width / 2, this._background.height / 2, 0);
    } else {
      const [pointerX, pointerY] = global.get_pointer();
      const [clampedX, clampedY] = this._clampToToMonitor(pointerX, pointerY, 10);
      this._root.set_translation(clampedX, clampedY, 0);
      this._selectionWedges.set_translation(clampedX, clampedY, 0);

      if (pointerX != clampedX || pointerY != clampedY) {
        this._input.warpPointer(clampedX, clampedY);
      }
    }

    return this._menuID;
  }

  // ----------------------------------------------------------------------- private stuff

  // Hides the menu and the background actor.
  _hide() {

    // The menu is not active; nothing to be done.
    if (this._menuID == null) {
      return;
    }

    // Fade out the background actor. Once this transition is completed, the _root item
    // will be destroyed by the background's "transitions-completed" signal handler.
    this._background.hide();

    // Rest menu ID. With this set to null, we can accept new menu requests.
    this._menuID = null;

    // Reset some other members.
    this._draggedChild       = null;
    this._menuSelectionChain = [];
  }

  // This method recursively traverses the menu structure and assigns an ID to each
  // item. If an item already has an ID property, this is not touched. This ID will be
  // passed to the OnSelect handler. The default IDs are paths like /0/2/1.
  _updateItemIDs(items, parentID) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.id) {
        if (parentID) {
          item.id = parentID + '/' + i;
        } else {
          item.id = '/' + i;
        }
      }

      // Proceed recursively with the children.
      if (item.children) {
        this._updateItemIDs(item.children, item.id);
      }
    }
  }

  // This method recursively traverses the menu structure and assigns an angle to each
  // item. If an item already has an angle property, this is considered a fixed angle and
  // all others are distributed more ore less evenly around. This method also reserves the
  // required angular space for the back navigation link to the parent item. Angles in
  // items are always in degrees, 0° is on the top, 90° on the right, 180° on the bottom
  // and so on. This method returns true on success, false otherwise.
  _updateItemAngles(items, parentAngle) {

    // Shouldn't happen, but who knows...
    if (items.length == 0) {
      return true;
    }

    // First we calculate all angles for the current menu level. We begin by storing all
    // fixed angles.
    const fixedAngles = [];
    items.forEach((item, index) => {
      if ('angle' in item && item.angle >= 0) {
        fixedAngles.push({angle: item.angle, index: index});
      }
    });

    // Make sure that the fixed angles increase monotonically and are between 0° and 360°.
    for (let i = 0; i < fixedAngles.length; i++) {
      if (i > 0 && fixedAngles[i].angle <= fixedAngles[i - 1].angle) {
        return false;
      }

      if (fixedAngles[i].angle < 0.0 || fixedAngles[i].angle >= 360.0) {
        return false;
      }
    }

    // Make sure that the parent link does not collide with a fixed item. For now, we
    // consider a difference of less than 1° a collision.
    if (parentAngle != undefined) {
      for (let i = 0; i < fixedAngles.length; i++) {
        if (Math.abs(fixedAngles[i].angle - parentAngle) < 1.0) {
          return false;
        }
      }
    }

    // If no item has a fixed angle, we assign one to the first item. This should be left
    // or right, depending on the position of the parent item.
    if (fixedAngles.length == 0) {
      let firstAngle = 90;
      if (parentAngle != undefined && parentAngle < 180) {
        firstAngle = 270;
      }
      fixedAngles.push({angle: firstAngle, index: 0});
      items[0].angle = firstAngle;
    }

    // Now we iterate through the fixed angles, always considering wedges between
    // consecutive pairs of fixed angles. If there is only one fixed angle, there is also
    // only one 360°-wedge.
    for (let i = 0; i < fixedAngles.length; i++) {
      let wedgeBeginIndex = fixedAngles[i].index;
      let wedgeBeginAngle = fixedAngles[i].angle;
      let wedgeEndIndex   = fixedAngles[(i + 1) % fixedAngles.length].index;
      let wedgeEndAngle   = fixedAngles[(i + 1) % fixedAngles.length].angle;

      // Make sure we loop around.
      if (wedgeEndAngle <= wedgeBeginAngle) {
        wedgeEndAngle += 360;
      }

      // Calculate the number of items between the begin and end indices.
      let wedgeItemCount =
          (wedgeEndIndex - wedgeBeginIndex - 1 + items.length) % items.length;

      // We have one item more if the parent link is inside our wedge.
      let parentInWedge = false;

      if (parentAngle != undefined) {
        // It can be that the parent link is inside the current wedge, but it's angle if
        // one full turn off.
        if (parentAngle < wedgeBeginAngle) {
          parentAngle += 360;
        }

        parentInWedge = parentAngle > wedgeBeginAngle && parentAngle < wedgeEndAngle;
        if (parentInWedge) {
          wedgeItemCount += 1;
        }
      }

      // Calculate the angular difference between consecutive items in the current wedge.
      const wedgeItemGap = (wedgeEndAngle - wedgeBeginAngle) / (wedgeItemCount + 1);

      // Now we assign an angle to each item between the begin and end indices.
      let index             = (wedgeBeginIndex + 1) % items.length;
      let count             = 1;
      let parentGapRequired = parentInWedge;

      while (index != wedgeEndIndex) {
        let itemAngle = wedgeBeginAngle + wedgeItemGap * count;

        // Insert gap for parent link if required.
        if (parentGapRequired && itemAngle + wedgeItemGap / 2 - parentAngle > 0) {
          count += 1;
          itemAngle         = wedgeBeginAngle + wedgeItemGap * count;
          parentGapRequired = false;
        }

        items[index].angle = itemAngle % 360;

        index = (index + 1) % items.length;
        count += 1;
      }
    }

    // Now that all angles are set, update the child items.
    items.forEach(item => {
      if (item.children) {
        if (!this._updateItemAngles(item.children, (item.angle + 180) % 360)) {
          return false;
        }
      }
    });

    return true;
  }

  // This is called every time a settings key changes. This is simply forwarded to all
  // items which need redrawing. This could definitely be optimized.
  _onSettingsChange() {

    // Notify the selection wedges on the change.
    this._selectionWedges.onSettingsChange(this._settings);

    // Then call onSettingsChange() for each item of our menu. This ensures that the menu
    // is instantly updated in preview mode.
    if (this._root != undefined) {
      this._root.onSettingsChange(this._settings);
      this._root.redraw();
    }
  }

  // x and y are the center coordinates of a MenuItem. This method returns a new position
  // [x, y] which ensures that the MenuItem and all of its children and grandchildren are
  // inside the current monitor's bounds, including the specified margin. This is done by
  // calculating the theoretically largest extends based on the current appearance
  // settings.
  _clampToToMonitor(x, y, margin) {

    const wedgeRadius  = this._settings.get_double('wedge-inner-radius');
    const centerRadius = Math.max(
        this._settings.get_double('center-size') / 2,
        this._settings.get_double('center-size-hover') / 2);
    const childRadius = Math.max(
        this._settings.get_double('child-size') / 2 +
            this._settings.get_double('child-offset'),
        this._settings.get_double('child-size-hover') / 2 +
            this._settings.get_double('child-offset-hover'));
    const grandchildRadius = Math.max(
        this._settings.get_double('child-offset') +
            this._settings.get_double('grandchild-size') / 2 +
            this._settings.get_double('grandchild-offset'),
        this._settings.get_double('child-offset-hover') +
            this._settings.get_double('grandchild-size-hover') / 2 +
            this._settings.get_double('grandchild-offset-hover'));

    // Calculate theoretically largest extent.
    let maxSize = wedgeRadius;
    maxSize     = Math.max(maxSize, centerRadius);
    maxSize     = Math.max(maxSize, childRadius);
    maxSize     = Math.max(maxSize, grandchildRadius);
    maxSize *= 2 * this._settings.get_double('global-scale');

    // Clamp to monitor bounds.
    const monitor = Main.layoutManager.currentMonitor;

    const min  = margin + maxSize / 2;
    const maxX = monitor.width - min;
    const maxY = monitor.height - min;

    const posX = Math.min(Math.max(x, min), maxX);
    const posY = Math.min(Math.max(y, min), maxY);

    // Ensure integer position.
    return [Math.floor(posX), Math.floor(posY)];
  }
};