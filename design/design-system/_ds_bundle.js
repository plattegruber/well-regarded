/* @ds-bundle: {"format":4,"namespace":"WellRegardedDesignSystem_71432a","components":[{"name":"Button","sourcePath":"components/actions/Button.jsx"},{"name":"IconButton","sourcePath":"components/actions/IconButton.jsx"},{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"RatingStars","sourcePath":"components/display/RatingStars.jsx"},{"name":"Tag","sourcePath":"components/display/Tag.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"RadioGroup","sourcePath":"components/forms/RadioGroup.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"},{"name":"Dialog","sourcePath":"components/overlay/Dialog.jsx"},{"name":"Toast","sourcePath":"components/overlay/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/overlay/Tooltip.jsx"}],"sourceHashes":{"components/actions/Button.jsx":"d6486c860be5","components/actions/IconButton.jsx":"efb68e923b3d","components/display/Badge.jsx":"b80425335436","components/display/Card.jsx":"22aff5499c96","components/display/RatingStars.jsx":"11bdb09b5961","components/display/Tag.jsx":"c4701f13f199","components/forms/Checkbox.jsx":"1871f51ff977","components/forms/Input.jsx":"f5e32445ec8a","components/forms/RadioGroup.jsx":"91d984c77e65","components/forms/Select.jsx":"8c81086cf8e9","components/forms/Switch.jsx":"ca8f20e95e2f","components/navigation/Tabs.jsx":"24238695ab4d","components/overlay/Dialog.jsx":"897126f20dc8","components/overlay/Toast.jsx":"acdad4fbadb0","components/overlay/Tooltip.jsx":"af9751cfdefe","ui_kits/app/AppShell.jsx":"71cf05777327","ui_kits/app/OverviewScreen.jsx":"119f10e25e16","ui_kits/app/RequestsScreen.jsx":"1012738ab5d2","ui_kits/app/ReviewsScreen.jsx":"7df7460600b1","ui_kits/app/data.js":"ec2b391cac14","ui_kits/website/Sections.jsx":"026799f973c3"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {
  const __ds_ns = (window.WellRegardedDesignSystem_71432a =
    window.WellRegardedDesignSystem_71432a || {});

  const __ds_scope = {};

  __ds_ns.__errors = __ds_ns.__errors || [];

  // components/actions/Button.jsx
  try {
    (() => {
      const btnSizes = {
        sm: {
          font: "600 11px/1 var(--font-mono)",
          padding: "8px 12px",
          gap: 6,
        },
        md: {
          font: "600 12px/1 var(--font-mono)",
          padding: "12px 18px",
          gap: 8,
        },
        lg: {
          font: "600 13px/1 var(--font-mono)",
          padding: "15px 26px",
          gap: 8,
        },
      };
      const btnVariants = {
        primary: {
          background: "var(--ink-900)",
          color: "var(--text-on-dark)",
          border: "1px solid var(--ink-900)",
          hoverBg: "var(--ink-700)",
          activeBg: "#000000",
        },
        secondary: {
          background: "var(--surface-card)",
          color: "var(--ink-900)",
          border: "1px solid var(--ink-900)",
          hoverBg: "var(--gray-50)",
          activeBg: "var(--gray-100)",
        },
        ghost: {
          background: "transparent",
          color: "var(--ink-900)",
          border: "1px solid transparent",
          hoverBg: "var(--gray-100)",
          activeBg: "var(--gray-200)",
        },
        danger: {
          background: "var(--red-700)",
          color: "var(--text-on-dark)",
          border: "1px solid var(--red-700)",
          hoverBg: "#A83521",
          activeBg: "#8E2C1B",
        },
      };
      function Button({
        variant = "primary",
        size = "md",
        disabled = false,
        fullWidth = false,
        onClick,
        children,
        style,
      }) {
        const [state, setState] = React.useState("rest");
        const v = btnVariants[variant] || btnVariants.primary;
        const s = btnSizes[size] || btnSizes.md;
        const bg = disabled
          ? v.background
          : state === "active"
            ? v.activeBg
            : state === "hover"
              ? v.hoverBg
              : v.background;
        return /*#__PURE__*/ React.createElement(
          "button",
          {
            type: "button",
            disabled: disabled,
            onClick: onClick,
            onMouseEnter: () => setState("hover"),
            onMouseLeave: () => setState("rest"),
            onMouseDown: () => setState("active"),
            onMouseUp: () => setState("hover"),
            style: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: s.gap,
              font: s.font,
              padding: s.padding,
              textTransform: "uppercase",
              letterSpacing: "var(--tracking-label)",
              background: bg,
              color: v.color,
              border: v.border,
              borderRadius: "var(--radius-md)",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.4 : 1,
              width: fullWidth ? "100%" : undefined,
              transition: "background var(--duration-fast) var(--ease-out)",
              ...style,
            },
          },
          children,
        );
      }
      Object.assign(__ds_scope, { Button });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/actions/Button.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/actions/IconButton.jsx
  try {
    (() => {
      const iconBtnSizes = {
        sm: 28,
        md: 36,
        lg: 44,
      };
      function IconButton({
        size = "md",
        variant = "ghost",
        label,
        disabled = false,
        onClick,
        children,
        style,
      }) {
        const [hover, setHover] = React.useState(false);
        const px = iconBtnSizes[size] || iconBtnSizes.md;
        const solid = variant === "solid";
        return /*#__PURE__*/ React.createElement(
          "button",
          {
            type: "button",
            "aria-label": label,
            title: label,
            disabled: disabled,
            onClick: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: px,
              height: px,
              padding: 0,
              background: solid
                ? hover && !disabled
                  ? "var(--ink-700)"
                  : "var(--ink-900)"
                : hover && !disabled
                  ? "var(--gray-100)"
                  : "transparent",
              color: solid ? "var(--text-on-dark)" : "var(--gray-600)",
              border:
                variant === "outline"
                  ? "1px solid var(--border-strong)"
                  : "1px solid transparent",
              borderRadius: "var(--radius-md)",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.45 : 1,
              transition: "background var(--duration-fast) var(--ease-out)",
              ...style,
            },
          },
          children,
        );
      }
      Object.assign(__ds_scope, { IconButton });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/actions/IconButton.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Badge.jsx
  try {
    (() => {
      const badgeTones = {
        neutral: {
          bg: "var(--gray-100)",
          fg: "var(--gray-600)",
        },
        brand: {
          bg: "var(--ink-900)",
          fg: "var(--text-on-dark)",
        },
        positive: {
          bg: "var(--status-positive-bg)",
          fg: "var(--accent-800)",
        },
        caution: {
          bg: "var(--status-caution-bg)",
          fg: "var(--status-caution)",
        },
        negative: {
          bg: "var(--status-negative-bg)",
          fg: "var(--status-negative)",
        },
        gold: {
          bg: "var(--accent-100)",
          fg: "var(--accent-800)",
        },
      };
      function Badge({ tone = "neutral", children, style }) {
        const t = badgeTones[tone] || badgeTones.neutral;
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              font: "500 10.5px/1 var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: "var(--tracking-label)",
              color: t.fg,
              background: t.bg,
              padding: "5px 8px",
              borderRadius: 0,
              whiteSpace: "nowrap",
              ...style,
            },
          },
          children,
        );
      }
      Object.assign(__ds_scope, { Badge });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Badge.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Card.jsx
  try {
    (() => {
      function Card({
        title,
        action,
        padding = "20px",
        sunken = false,
        children,
        style,
      }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              background: sunken
                ? "var(--surface-sunken)"
                : "var(--surface-card)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-lg)",
              boxShadow: sunken ? "none" : "var(--shadow-card)",
              padding,
              boxSizing: "border-box",
              ...style,
            },
          },
          (title || action) &&
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 14,
                },
              },
              title &&
                /*#__PURE__*/ React.createElement(
                  "h3",
                  {
                    style: {
                      margin: 0,
                      font: "var(--text-title)",
                      color: "var(--text-primary)",
                    },
                  },
                  title,
                ),
              action,
            ),
          children,
        );
      }
      Object.assign(__ds_scope, { Card });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Card.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/RatingStars.jsx
  try {
    (() => {
      const starPath =
        "M12 2l2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17.1 6 20.4l1.3-6.7-5-4.7 6.8-.8z";
      function RatingStars({
        rating = 0,
        max = 5,
        size = 16,
        showValue = false,
        style,
      }) {
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement(
            "span",
            {
              style: {
                display: "inline-flex",
                gap: 2,
              },
              "aria-label": `${rating} of ${max} stars`,
            },
            Array.from(
              {
                length: max,
              },
              (_, i) => {
                const fill = Math.max(0, Math.min(1, rating - i));
                return /*#__PURE__*/ React.createElement(
                  "svg",
                  {
                    key: i,
                    width: size,
                    height: size,
                    viewBox: "0 0 24 24",
                    style: {
                      display: "block",
                    },
                  },
                  /*#__PURE__*/ React.createElement("path", {
                    d: starPath,
                    fill: "var(--gray-300)",
                  }),
                  fill > 0 &&
                    /*#__PURE__*/ React.createElement(
                      "g",
                      {
                        style: {
                          clipPath:
                            fill < 1
                              ? `inset(0 ${(1 - fill) * 100}% 0 0)`
                              : undefined,
                        },
                      },
                      /*#__PURE__*/ React.createElement("path", {
                        d: starPath,
                        fill: "var(--accent-star)",
                      }),
                    ),
                );
              },
            ),
          ),
          showValue &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "600 14px/1 var(--font-sans)",
                  fontFeatureSettings: "var(--numeric)",
                  color: "var(--text-primary)",
                },
              },
              Number(rating).toFixed(1),
            ),
        );
      }
      Object.assign(__ds_scope, { RatingStars });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/RatingStars.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/display/Tag.jsx
  try {
    (() => {
      function Tag({ selected = false, onRemove, onClick, children, style }) {
        const [hover, setHover] = React.useState(false);
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            onClick: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              font: "500 12px/1 var(--font-mono)",
              color: selected ? "var(--text-on-dark)" : "var(--text-primary)",
              background: selected
                ? "var(--ink-900)"
                : hover && onClick
                  ? "var(--gray-50)"
                  : "var(--surface-card)",
              border: `1px solid ${selected ? "var(--ink-900)" : "var(--border-strong)"}`,
              padding: "7px 10px",
              borderRadius: "var(--radius-sm)",
              cursor: onClick ? "pointer" : "default",
              whiteSpace: "nowrap",
              transition: "background var(--duration-fast) var(--ease-out)",
              ...style,
            },
          },
          children,
          onRemove &&
            /*#__PURE__*/ React.createElement(
              "svg",
              {
                onClick: (e) => {
                  e.stopPropagation();
                  onRemove();
                },
                width: "12",
                height: "12",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: "2.5",
                strokeLinecap: "round",
                style: {
                  cursor: "pointer",
                  opacity: 0.6,
                },
              },
              /*#__PURE__*/ React.createElement("path", {
                d: "M18 6 6 18M6 6l12 12",
              }),
            ),
        );
      }
      Object.assign(__ds_scope, { Tag });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/display/Tag.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Checkbox.jsx
  try {
    (() => {
      function Checkbox({
        label,
        checked,
        defaultChecked = false,
        disabled = false,
        onChange,
        style,
      }) {
        const [internal, setInternal] = React.useState(defaultChecked);
        const isOn = checked !== undefined ? checked : internal;
        const toggle = () => {
          if (disabled) return;
          if (checked === undefined) setInternal(!isOn);
          onChange && onChange(!isOn);
        };
        return /*#__PURE__*/ React.createElement(
          "label",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement(
            "span",
            {
              role: "checkbox",
              "aria-checked": isOn,
              tabIndex: disabled ? -1 : 0,
              onClick: toggle,
              onKeyDown: (e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggle();
                }
              },
              style: {
                width: 18,
                height: 18,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: isOn ? "var(--accent-600)" : "var(--surface-card)",
                border: `1.5px solid ${isOn ? "var(--accent-600)" : "var(--border-strong)"}`,
                borderRadius: 0,
                boxSizing: "border-box",
                transition: "background var(--duration-fast) var(--ease-out)",
              },
            },
            isOn &&
              /*#__PURE__*/ React.createElement(
                "svg",
                {
                  width: "11",
                  height: "11",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "white",
                  strokeWidth: "3.5",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                },
                /*#__PURE__*/ React.createElement("path", {
                  d: "M20 6 9 17l-5-5",
                }),
              ),
          ),
          label &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "var(--text-body)",
                  color: "var(--text-primary)",
                },
                onClick: toggle,
              },
              label,
            ),
        );
      }
      Object.assign(__ds_scope, { Checkbox });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Checkbox.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Input.jsx
  try {
    (() => {
      function Input({
        label,
        hint,
        error,
        type = "text",
        value,
        defaultValue,
        placeholder,
        disabled = false,
        onChange,
        style,
      }) {
        const [focus, setFocus] = React.useState(false);
        const id = React.useId();
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              ...style,
            },
          },
          label &&
            /*#__PURE__*/ React.createElement(
              "label",
              {
                htmlFor: id,
                style: {
                  font: "var(--text-label)",
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                },
              },
              label,
            ),
          /*#__PURE__*/ React.createElement("input", {
            id: id,
            type: type,
            value: value,
            defaultValue: defaultValue,
            placeholder: placeholder,
            disabled: disabled,
            onChange: onChange,
            onFocus: () => setFocus(true),
            onBlur: () => setFocus(false),
            style: {
              font: "var(--text-body)",
              color: "var(--text-primary)",
              padding: "10px 12px",
              background: disabled
                ? "var(--surface-sunken)"
                : "var(--surface-card)",
              border: `1px solid ${error ? "var(--status-negative)" : focus ? "var(--border-brand)" : "var(--border-strong)"}`,
              borderRadius: "var(--radius-sm)",
              outline: "none",
              boxShadow: focus ? "var(--focus-ring)" : "none",
              opacity: disabled ? 0.6 : 1,
              transition:
                "box-shadow var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out)",
            },
          }),
          (error || hint) &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "var(--text-small)",
                  color: error ? "var(--text-danger)" : "var(--text-tertiary)",
                },
              },
              error || hint,
            ),
        );
      }
      Object.assign(__ds_scope, { Input });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Input.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/RadioGroup.jsx
  try {
    (() => {
      function RadioGroup({
        label,
        options = [],
        value,
        defaultValue,
        disabled = false,
        onChange,
        style,
      }) {
        const [internal, setInternal] = React.useState(defaultValue);
        const current = value !== undefined ? value : internal;
        const pick = (v) => {
          if (disabled) return;
          if (value === undefined) setInternal(v);
          onChange && onChange(v);
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            role: "radiogroup",
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 10,
              opacity: disabled ? 0.5 : 1,
              ...style,
            },
          },
          label &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "var(--text-label)",
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                },
              },
              label,
            ),
          options.map((o) => {
            const opt =
              typeof o === "string"
                ? {
                    value: o,
                    label: o,
                  }
                : o;
            const on = current === opt.value;
            return /*#__PURE__*/ React.createElement(
              "label",
              {
                key: opt.value,
                style: {
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: disabled ? "default" : "pointer",
                },
                onClick: () => pick(opt.value),
              },
              /*#__PURE__*/ React.createElement("span", {
                role: "radio",
                "aria-checked": on,
                tabIndex: disabled ? -1 : 0,
                onKeyDown: (e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    pick(opt.value);
                  }
                },
                style: {
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                  borderRadius: "50%",
                  boxSizing: "border-box",
                  border: `${on ? 6 : 1.5}px solid ${on ? "var(--accent-600)" : "var(--border-strong)"}`,
                  background: "var(--surface-card)",
                  transition: "border var(--duration-fast) var(--ease-out)",
                },
              }),
              /*#__PURE__*/ React.createElement(
                "span",
                {
                  style: {
                    font: "var(--text-body)",
                    color: "var(--text-primary)",
                  },
                },
                opt.label,
              ),
            );
          }),
        );
      }
      Object.assign(__ds_scope, { RadioGroup });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/RadioGroup.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Select.jsx
  try {
    (() => {
      function Select({
        label,
        options = [],
        value,
        defaultValue,
        disabled = false,
        onChange,
        style,
      }) {
        const [focus, setFocus] = React.useState(false);
        const id = React.useId();
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              ...style,
            },
          },
          label &&
            /*#__PURE__*/ React.createElement(
              "label",
              {
                htmlFor: id,
                style: {
                  font: "var(--text-label)",
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--text-secondary)",
                },
              },
              label,
            ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                position: "relative",
              },
            },
            /*#__PURE__*/ React.createElement(
              "select",
              {
                id: id,
                value: value,
                defaultValue: defaultValue,
                disabled: disabled,
                onChange: onChange,
                onFocus: () => setFocus(true),
                onBlur: () => setFocus(false),
                style: {
                  width: "100%",
                  appearance: "none",
                  font: "var(--text-body)",
                  color: "var(--text-primary)",
                  padding: "10px 34px 10px 12px",
                  background: disabled
                    ? "var(--surface-sunken)"
                    : "var(--surface-card)",
                  border: `1px solid ${focus ? "var(--border-brand)" : "var(--border-strong)"}`,
                  borderRadius: "var(--radius-sm)",
                  outline: "none",
                  cursor: disabled ? "default" : "pointer",
                  boxShadow: focus ? "var(--focus-ring)" : "none",
                  transition: "box-shadow var(--duration-fast) var(--ease-out)",
                },
              },
              options.map((o) => {
                const opt =
                  typeof o === "string"
                    ? {
                        value: o,
                        label: o,
                      }
                    : o;
                return /*#__PURE__*/ React.createElement(
                  "option",
                  {
                    key: opt.value,
                    value: opt.value,
                  },
                  opt.label,
                );
              }),
            ),
            /*#__PURE__*/ React.createElement(
              "svg",
              {
                width: "14",
                height: "14",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "var(--gray-500)",
                strokeWidth: "2",
                strokeLinecap: "round",
                strokeLinejoin: "round",
                style: {
                  position: "absolute",
                  right: 12,
                  top: "50%",
                  transform: "translateY(-50%)",
                  pointerEvents: "none",
                },
              },
              /*#__PURE__*/ React.createElement("path", {
                d: "m6 9 6 6 6-6",
              }),
            ),
          ),
        );
      }
      Object.assign(__ds_scope, { Select });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Select.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/forms/Switch.jsx
  try {
    (() => {
      function Switch({
        label,
        checked,
        defaultChecked = false,
        disabled = false,
        onChange,
        style,
      }) {
        const [internal, setInternal] = React.useState(defaultChecked);
        const isOn = checked !== undefined ? checked : internal;
        const toggle = () => {
          if (disabled) return;
          if (checked === undefined) setInternal(!isOn);
          onChange && onChange(!isOn);
        };
        return /*#__PURE__*/ React.createElement(
          "label",
          {
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.5 : 1,
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement(
            "span",
            {
              role: "switch",
              "aria-checked": isOn,
              tabIndex: disabled ? -1 : 0,
              onClick: toggle,
              onKeyDown: (e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggle();
                }
              },
              style: {
                width: 36,
                height: 21,
                flexShrink: 0,
                borderRadius: "var(--radius-full)",
                position: "relative",
                background: isOn ? "var(--accent-600)" : "var(--gray-300)",
                boxSizing: "border-box",
                transition: "background var(--duration-base) var(--ease-out)",
              },
            },
            /*#__PURE__*/ React.createElement("span", {
              style: {
                position: "absolute",
                top: 2.5,
                left: isOn ? 17.5 : 2.5,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "var(--white)",
                boxShadow: "0 1px 2px rgba(12,15,14,.3)",
                transition: "left var(--duration-base) var(--ease-out)",
              },
            }),
          ),
          label &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "var(--text-body)",
                  color: "var(--text-primary)",
                },
                onClick: toggle,
              },
              label,
            ),
        );
      }
      Object.assign(__ds_scope, { Switch });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/forms/Switch.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/navigation/Tabs.jsx
  try {
    (() => {
      function Tabs({ tabs = [], value, defaultValue, onChange, style }) {
        const norm = tabs.map((t) =>
          typeof t === "string"
            ? {
                value: t,
                label: t,
              }
            : t,
        );
        const [internal, setInternal] = React.useState(
          defaultValue !== undefined ? defaultValue : norm[0] && norm[0].value,
        );
        const current = value !== undefined ? value : internal;
        const pick = (v) => {
          if (value === undefined) setInternal(v);
          onChange && onChange(v);
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            role: "tablist",
            style: {
              display: "flex",
              gap: 4,
              borderBottom: "1px solid var(--border-default)",
              ...style,
            },
          },
          norm.map((t) => {
            const on = current === t.value;
            return /*#__PURE__*/ React.createElement(
              "button",
              {
                key: t.value,
                role: "tab",
                "aria-selected": on,
                type: "button",
                onClick: () => pick(t.value),
                style: {
                  font: on ? "var(--text-body-strong)" : "var(--text-body)",
                  fontSize: 14,
                  color: on ? "var(--text-brand)" : "var(--text-secondary)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "10px 14px",
                  marginBottom: -1,
                  borderBottom: `2px solid ${on ? "var(--accent-600)" : "transparent"}`,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  transition: "color var(--duration-fast) var(--ease-out)",
                },
              },
              t.label,
              t.count !== undefined &&
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    style: {
                      font: "500 10.5px/1 var(--font-mono)",
                      padding: "3px 6px",
                      borderRadius: 0,
                      background: on ? "var(--accent-100)" : "var(--gray-100)",
                      color: on ? "var(--accent-700)" : "var(--gray-600)",
                      fontFeatureSettings: "var(--numeric)",
                    },
                  },
                  t.count,
                ),
            );
          }),
        );
      }
      Object.assign(__ds_scope, { Tabs });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/navigation/Tabs.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/overlay/Dialog.jsx
  try {
    (() => {
      function Dialog({
        open = false,
        title,
        description,
        footer,
        onClose,
        width = 480,
        children,
        style,
      }) {
        if (!open) return null;
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            onClick: (e) => {
              if (e.target === e.currentTarget && onClose) onClose();
            },
            style: {
              position: "fixed",
              inset: 0,
              zIndex: 100,
              background: "rgba(12, 15, 14, 0.5)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              role: "dialog",
              "aria-modal": "true",
              style: {
                width,
                maxWidth: "100%",
                maxHeight: "85vh",
                overflow: "auto",
                background: "var(--surface-card)",
                borderRadius: "var(--radius-lg)",
                boxShadow: "var(--shadow-overlay)",
                padding: 24,
                boxSizing: "border-box",
                ...style,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                },
              },
              /*#__PURE__*/ React.createElement(
                "div",
                null,
                title &&
                  /*#__PURE__*/ React.createElement(
                    "h2",
                    {
                      style: {
                        margin: 0,
                        font: "var(--text-display-sm)",
                        letterSpacing: "var(--tracking-display)",
                        color: "var(--text-primary)",
                      },
                    },
                    title,
                  ),
                description &&
                  /*#__PURE__*/ React.createElement(
                    "p",
                    {
                      style: {
                        margin: "8px 0 0",
                        font: "var(--text-body)",
                        color: "var(--text-secondary)",
                      },
                    },
                    description,
                  ),
              ),
              onClose &&
                /*#__PURE__*/ React.createElement(
                  "button",
                  {
                    type: "button",
                    "aria-label": "Close",
                    onClick: onClose,
                    style: {
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 6,
                      margin: -6,
                      color: "var(--gray-500)",
                      display: "inline-flex",
                      borderRadius: "var(--radius-sm)",
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    "svg",
                    {
                      width: "18",
                      height: "18",
                      viewBox: "0 0 24 24",
                      fill: "none",
                      stroke: "currentColor",
                      strokeWidth: "2",
                      strokeLinecap: "round",
                    },
                    /*#__PURE__*/ React.createElement("path", {
                      d: "M18 6 6 18M6 6l12 12",
                    }),
                  ),
                ),
            ),
            children &&
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 18,
                  },
                },
                children,
              ),
            footer &&
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    marginTop: 22,
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                  },
                },
                footer,
              ),
          ),
        );
      }
      Object.assign(__ds_scope, { Dialog });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/overlay/Dialog.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/overlay/Toast.jsx
  try {
    (() => {
      function Toast({ tone = "neutral", message, detail, onDismiss, style }) {
        const icons = {
          positive: /*#__PURE__*/ React.createElement("path", {
            d: "M20 6 9 17l-5-5",
          }),
          negative: /*#__PURE__*/ React.createElement("path", {
            d: "M18 6 6 18M6 6l12 12",
          }),
          neutral: /*#__PURE__*/ React.createElement("path", {
            d: "M12 8v5M12 16.5v.5",
          }),
        };
        const iconColor =
          tone === "positive"
            ? "var(--accent-500)"
            : tone === "negative"
              ? "#D08573"
              : "var(--gray-400)";
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            role: "status",
            style: {
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              background: "var(--surface-inverse)",
              color: "var(--text-on-dark)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-raised)",
              padding: "12px 14px",
              maxWidth: 380,
              boxSizing: "border-box",
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement(
            "svg",
            {
              width: "16",
              height: "16",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: iconColor,
              strokeWidth: "2.5",
              strokeLinecap: "round",
              strokeLinejoin: "round",
              style: {
                flexShrink: 0,
                marginTop: 2,
              },
            },
            icons[tone] || icons.neutral,
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                flex: 1,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  font: "600 14px/1.4 var(--font-sans)",
                },
              },
              message,
            ),
            detail &&
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    font: "var(--text-small)",
                    opacity: 0.7,
                    marginTop: 2,
                  },
                },
                detail,
              ),
          ),
          onDismiss &&
            /*#__PURE__*/ React.createElement(
              "button",
              {
                type: "button",
                "aria-label": "Dismiss",
                onClick: onDismiss,
                style: {
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 2,
                  color: "inherit",
                  opacity: 0.6,
                  display: "inline-flex",
                },
              },
              /*#__PURE__*/ React.createElement(
                "svg",
                {
                  width: "14",
                  height: "14",
                  viewBox: "0 0 24 24",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: "2",
                  strokeLinecap: "round",
                },
                /*#__PURE__*/ React.createElement("path", {
                  d: "M18 6 6 18M6 6l12 12",
                }),
              ),
            ),
        );
      }
      Object.assign(__ds_scope, { Toast });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/overlay/Toast.jsx",
      error: String((e && e.message) || e),
    });
  }

  // components/overlay/Tooltip.jsx
  try {
    (() => {
      function Tooltip({ text, side = "top", children, style }) {
        const [show, setShow] = React.useState(false);
        const pos = {
          top: {
            bottom: "calc(100% + 7px)",
            left: "50%",
            transform: "translateX(-50%)",
          },
          bottom: {
            top: "calc(100% + 7px)",
            left: "50%",
            transform: "translateX(-50%)",
          },
          left: {
            right: "calc(100% + 7px)",
            top: "50%",
            transform: "translateY(-50%)",
          },
          right: {
            left: "calc(100% + 7px)",
            top: "50%",
            transform: "translateY(-50%)",
          },
        };
        return /*#__PURE__*/ React.createElement(
          "span",
          {
            onMouseEnter: () => setShow(true),
            onMouseLeave: () => setShow(false),
            style: {
              position: "relative",
              display: "inline-flex",
              ...style,
            },
          },
          children,
          show &&
            /*#__PURE__*/ React.createElement(
              "span",
              {
                role: "tooltip",
                style: {
                  position: "absolute",
                  zIndex: 200,
                  whiteSpace: "nowrap",
                  font: "500 12px/1.3 var(--font-sans)",
                  background: "var(--surface-inverse)",
                  color: "var(--text-on-dark)",
                  padding: "6px 9px",
                  borderRadius: "var(--radius-sm)",
                  boxShadow: "var(--shadow-raised)",
                  pointerEvents: "none",
                  ...pos[side],
                },
              },
              text,
            ),
        );
      }
      Object.assign(__ds_scope, { Tooltip });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "components/overlay/Tooltip.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/app/AppShell.jsx
  try {
    (() => {
      // App shell: sidebar navigation + top bar. Icons: Lucide-style inline SVGs (1.75 stroke).
      const { RatingStars } = window.WellRegardedDesignSystem_71432a;
      const wrIcon = (paths) =>
        /*#__PURE__*/ React.createElement("svg", {
          width: "18",
          height: "18",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.75",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          dangerouslySetInnerHTML: {
            __html: paths,
          },
        });
      const WR_NAV = [
        {
          key: "overview",
          label: "Overview",
          icon: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
        },
        {
          key: "reviews",
          label: "Reviews",
          icon: '<path d="M12 2l2.9 6.2 6.8.8-5 4.7 1.3 6.7L12 17.1 6 20.4l1.3-6.7-5-4.7 6.8-.8z"/>',
        },
        {
          key: "requests",
          label: "Requests",
          icon: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
        },
      ];
      function AppShell({ screen, onNavigate, children }) {
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "flex",
              minHeight: "100vh",
              background: "var(--surface-page)",
            },
          },
          /*#__PURE__*/ React.createElement(
            "aside",
            {
              style: {
                width: "var(--sidebar-width)",
                flexShrink: 0,
                background: "var(--surface-card)",
                borderRight: "1px solid var(--border-default)",
                display: "flex",
                flexDirection: "column",
                padding: "20px 12px",
                boxSizing: "border-box",
                position: "sticky",
                top: 0,
                height: "100vh",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  font: "500 20px/1 var(--font-display)",
                  letterSpacing: "var(--tracking-display)",
                  color: "var(--ink-900)",
                  padding: "0 10px 20px",
                },
              },
              "Well Regarded",
            ),
            /*#__PURE__*/ React.createElement(
              "nav",
              {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                },
              },
              WR_NAV.map((item) => {
                const on = screen === item.key;
                return /*#__PURE__*/ React.createElement(
                  "button",
                  {
                    key: item.key,
                    type: "button",
                    onClick: () => onNavigate(item.key),
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                      font: on
                        ? "600 14px/1 var(--font-sans)"
                        : "500 14px/1 var(--font-sans)",
                      color: on ? "var(--accent-700)" : "var(--gray-600)",
                      background: on ? "var(--accent-50)" : "transparent",
                      border: "none",
                      borderRadius: "var(--radius-md)",
                      padding: "10px 10px",
                      cursor: "pointer",
                      transition:
                        "background var(--duration-fast) var(--ease-out)",
                    },
                  },
                  wrIcon(item.icon),
                  " ",
                  item.label,
                );
              }),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  marginTop: "auto",
                  padding: "14px 10px",
                  borderTop: "1px solid var(--border-default)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                },
              },
              /*#__PURE__*/ React.createElement(
                "span",
                {
                  style: {
                    font: "var(--text-body-strong)",
                    fontSize: 13,
                  },
                },
                window.WR_DATA.practice.name,
              ),
              /*#__PURE__*/ React.createElement(RatingStars, {
                rating: window.WR_DATA.practice.rating,
                size: 12,
                showValue: true,
              }),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "main",
            {
              style: {
                flex: 1,
                minWidth: 0,
                padding: "28px 36px 48px",
                boxSizing: "border-box",
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  maxWidth: "var(--content-max)",
                  margin: "0 auto",
                },
              },
              children,
            ),
          ),
        );
      }
      Object.assign(window, {
        AppShell,
        wrIcon,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/app/AppShell.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/app/OverviewScreen.jsx
  try {
    (() => {
      // Overview: stats row + recent reviews + automation card.
      const { Card, Badge, Button, RatingStars, Switch } =
        window.WellRegardedDesignSystem_71432a;
      function OverviewScreen({ onNavigate }) {
        const d = window.WR_DATA;
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 24,
            },
          },
          /*#__PURE__*/ React.createElement(
            "header",
            {
              "data-screen-label": "Overview",
              style: {
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "space-between",
                gap: 16,
              },
            },
            /*#__PURE__*/ React.createElement(
              "div",
              null,
              /*#__PURE__*/ React.createElement(
                "h1",
                {
                  style: {
                    margin: 0,
                    font: "var(--text-display-md)",
                    letterSpacing: "var(--tracking-display)",
                  },
                },
                "Good morning",
              ),
              /*#__PURE__*/ React.createElement(
                "p",
                {
                  style: {
                    margin: "6px 0 0",
                    font: "var(--text-body)",
                    color: "var(--text-secondary)",
                  },
                },
                "Your practice is already well regarded. Here is how it is traveling.",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                onClick: () => onNavigate("requests"),
              },
              "Send request",
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 16,
              },
            },
            d.stats.map((s) =>
              /*#__PURE__*/ React.createElement(
                Card,
                {
                  key: s.label,
                  padding: "18px 20px",
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      font: "var(--text-label)",
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                    },
                  },
                  s.label,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      font: "500 32px/1.1 var(--font-display)",
                      fontFeatureSettings: "var(--numeric)",
                      margin: "8px 0 4px",
                    },
                  },
                  s.value,
                ),
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      font: "var(--text-small)",
                      color: "var(--text-tertiary)",
                    },
                  },
                  s.sub,
                ),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr",
                gap: 16,
                alignItems: "start",
              },
            },
            /*#__PURE__*/ React.createElement(
              Card,
              {
                title: "Recent reviews",
                action: /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "ghost",
                    size: "sm",
                    onClick: () => onNavigate("reviews"),
                  },
                  "See all",
                ),
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                  },
                },
                d.reviews.slice(0, 3).map((r, i) =>
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      key: r.id,
                      style: {
                        padding: "14px 0",
                        borderTop: i
                          ? "1px solid var(--border-default)"
                          : "none",
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      },
                    },
                    /*#__PURE__*/ React.createElement(
                      "div",
                      {
                        style: {
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        },
                      },
                      /*#__PURE__*/ React.createElement(RatingStars, {
                        rating: r.rating,
                        size: 13,
                      }),
                      /*#__PURE__*/ React.createElement(
                        "span",
                        {
                          style: {
                            font: "var(--text-body-strong)",
                            fontSize: 14,
                          },
                        },
                        r.author,
                      ),
                      /*#__PURE__*/ React.createElement(
                        "span",
                        {
                          style: {
                            font: "var(--text-small)",
                            color: "var(--text-tertiary)",
                          },
                        },
                        r.source,
                        " \xB7 ",
                        r.when,
                      ),
                      /*#__PURE__*/ React.createElement(
                        "span",
                        {
                          style: {
                            marginLeft: "auto",
                          },
                        },
                        r.status === "waiting" &&
                          /*#__PURE__*/ React.createElement(
                            Badge,
                            {
                              tone: "caution",
                            },
                            "Awaiting reply",
                          ),
                        r.status === "attention" &&
                          /*#__PURE__*/ React.createElement(
                            Badge,
                            {
                              tone: "negative",
                            },
                            "Needs attention",
                          ),
                        r.status === "replied" &&
                          /*#__PURE__*/ React.createElement(
                            Badge,
                            {
                              tone: "positive",
                            },
                            "Replied",
                          ),
                      ),
                    ),
                    /*#__PURE__*/ React.createElement(
                      "p",
                      {
                        style: {
                          margin: 0,
                          font: "var(--text-quote)",
                          fontSize: 15,
                          color: "var(--ink-800)",
                        },
                      },
                      "\u201C",
                      r.text,
                      "\u201D",
                    ),
                  ),
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Card,
              {
                title: "Asking for feedback",
              },
              /*#__PURE__*/ React.createElement(
                "p",
                {
                  style: {
                    margin: "0 0 14px",
                    font: "var(--text-body)",
                    color: "var(--text-secondary)",
                  },
                },
                "The patients who appreciate you are often the ones least likely to remember to leave a review.",
              ),
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  },
                },
                /*#__PURE__*/ React.createElement(Switch, {
                  label: "Ask automatically after visits",
                  defaultChecked: true,
                }),
                /*#__PURE__*/ React.createElement(Switch, {
                  label: "Wait 3 hours before asking",
                  defaultChecked: true,
                }),
                /*#__PURE__*/ React.createElement(Switch, {
                  label: "Ask again once, a week later",
                }),
              ),
            ),
          ),
        );
      }
      Object.assign(window, {
        OverviewScreen,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/app/OverviewScreen.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/app/RequestsScreen.jsx
  try {
    (() => {
      // Requests: send a feedback request + recent requests table.
      const {
        Card,
        Badge,
        Button,
        Input,
        Select,
        RadioGroup,
        Checkbox,
        Toast,
      } = window.WellRegardedDesignSystem_71432a;
      function RequestsScreen() {
        const d = window.WR_DATA;
        const [name, setName] = React.useState("");
        const [toast, setToast] = React.useState(null);
        const [sent, setSent] = React.useState([]);
        const send = () => {
          const who = name.trim() || "Your patient";
          setSent([
            {
              id: Date.now(),
              patient: who,
              visit: "Manual · today",
              channel: "Text",
              status: "Sent",
            },
            ...sent,
          ]);
          setToast({
            message: "Request sent",
            detail: `${who} will receive one text message.`,
          });
          setName("");
          setTimeout(() => setToast(null), 4000);
        };
        const statusBadge = (s) =>
          s === "Reviewed"
            ? /*#__PURE__*/ React.createElement(
                Badge,
                {
                  tone: "positive",
                },
                "Reviewed",
              )
            : s === "Opened"
              ? /*#__PURE__*/ React.createElement(
                  Badge,
                  {
                    tone: "brand",
                  },
                  "Opened",
                )
              : /*#__PURE__*/ React.createElement(Badge, null, "Sent");
        const rows = [...sent, ...d.requests];
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            "data-screen-label": "Requests",
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 20,
            },
          },
          /*#__PURE__*/ React.createElement(
            "header",
            null,
            /*#__PURE__*/ React.createElement(
              "h1",
              {
                style: {
                  margin: 0,
                  font: "var(--text-display-md)",
                  letterSpacing: "var(--tracking-display)",
                },
              },
              "Feedback requests",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: "6px 0 0",
                  font: "var(--text-body)",
                  color: "var(--text-secondary)",
                },
              },
              "A thoughtful way to ask. A simple way to keep up.",
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "grid",
                gridTemplateColumns: "1fr 1.6fr",
                gap: 16,
                alignItems: "start",
              },
            },
            /*#__PURE__*/ React.createElement(
              Card,
              {
                title: "Ask a patient",
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                  },
                },
                /*#__PURE__*/ React.createElement(Input, {
                  label: "Patient name",
                  placeholder: "Sofia Nguyen",
                  value: name,
                  onChange: (e) => setName(e.target.value),
                }),
                /*#__PURE__*/ React.createElement(Input, {
                  label: "Mobile number",
                  placeholder: "555-0140",
                  hint: "We only ask once.",
                }),
                /*#__PURE__*/ React.createElement(RadioGroup, {
                  label: "Send by",
                  options: ["Text message", "Email"],
                  defaultValue: "Text message",
                }),
                /*#__PURE__*/ React.createElement(Checkbox, {
                  label: "Include the doctor's name",
                  defaultChecked: true,
                }),
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    fullWidth: true,
                    onClick: send,
                  },
                  "Send request",
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Card,
              {
                title: "Recent requests",
                action: /*#__PURE__*/ React.createElement(Select, {
                  options: ["Last 30 days", "Last 90 days", "This year"],
                  style: {
                    width: 150,
                  },
                }),
              },
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  role: "table",
                  style: {
                    display: "flex",
                    flexDirection: "column",
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "1.4fr 1.2fr .7fr .8fr",
                      gap: 12,
                      padding: "8px 0",
                      font: "var(--text-label)",
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--text-secondary)",
                      borderBottom: "1px solid var(--border-default)",
                    },
                  },
                  /*#__PURE__*/ React.createElement("span", null, "Patient"),
                  /*#__PURE__*/ React.createElement("span", null, "Visit"),
                  /*#__PURE__*/ React.createElement("span", null, "Channel"),
                  /*#__PURE__*/ React.createElement("span", null, "Status"),
                ),
                rows.map((r, i) =>
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      key: r.id,
                      style: {
                        display: "grid",
                        gridTemplateColumns: "1.4fr 1.2fr .7fr .8fr",
                        gap: 12,
                        alignItems: "center",
                        padding: "12px 0",
                        borderBottom:
                          i < rows.length - 1
                            ? "1px solid var(--border-default)"
                            : "none",
                      },
                    },
                    /*#__PURE__*/ React.createElement(
                      "span",
                      {
                        style: {
                          font: "var(--text-body-strong)",
                          fontSize: 14,
                        },
                      },
                      r.patient,
                    ),
                    /*#__PURE__*/ React.createElement(
                      "span",
                      {
                        style: {
                          font: "var(--text-small)",
                          color: "var(--text-secondary)",
                        },
                      },
                      r.visit,
                    ),
                    /*#__PURE__*/ React.createElement(
                      "span",
                      {
                        style: {
                          font: "var(--text-small)",
                          color: "var(--text-secondary)",
                        },
                      },
                      r.channel,
                    ),
                    /*#__PURE__*/ React.createElement(
                      "span",
                      null,
                      statusBadge(r.status),
                    ),
                  ),
                ),
              ),
            ),
          ),
          toast &&
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  position: "fixed",
                  bottom: 24,
                  right: 24,
                  zIndex: 300,
                },
              },
              /*#__PURE__*/ React.createElement(Toast, {
                tone: "positive",
                message: toast.message,
                detail: toast.detail,
                onDismiss: () => setToast(null),
              }),
            ),
        );
      }
      Object.assign(window, {
        RequestsScreen,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/app/RequestsScreen.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/app/ReviewsScreen.jsx
  try {
    (() => {
      // Reviews inbox: tabs, filters, review list with reply composer dialog.
      const { Card, Badge, Button, Tag, Tabs, RatingStars, Dialog, Toast } =
        window.WellRegardedDesignSystem_71432a;
      function ReviewsScreen() {
        const d = window.WR_DATA;
        const [tab, setTab] = React.useState("all");
        const [source, setSource] = React.useState("All sources");
        const [replying, setReplying] = React.useState(null);
        const [draft, setDraft] = React.useState("");
        const [toast, setToast] = React.useState(null);
        const [replied, setReplied] = React.useState([]);
        const statusOf = (r) => (replied.includes(r.id) ? "replied" : r.status);
        const shown = d.reviews.filter((r) => {
          const st = statusOf(r);
          if (tab === "waiting" && st === "replied") return false;
          if (tab === "replied" && st !== "replied") return false;
          if (source !== "All sources" && r.source !== source) return false;
          return true;
        });
        const waitingCount = d.reviews.filter(
          (r) => statusOf(r) !== "replied",
        ).length;
        const openReply = (r) => {
          setReplying(r);
          setDraft(
            r.rating >= 4
              ? `Thank you, ${r.author.split(" ")[0]}. It means a great deal to the whole team that you felt at ease. We look forward to seeing you next time.`
              : "Thank you for telling us. This is not the experience we want anyone to have — please call the front desk and ask for Carmen so we can put it right.",
          );
        };
        const sendReply = () => {
          setReplied([...replied, replying.id]);
          setToast({
            message: "Reply sent",
            detail: `${replying.author} will see it on ${replying.source}.`,
          });
          setReplying(null);
          setTimeout(() => setToast(null), 4000);
        };
        return /*#__PURE__*/ React.createElement(
          "div",
          {
            "data-screen-label": "Reviews",
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 20,
            },
          },
          /*#__PURE__*/ React.createElement(
            "header",
            null,
            /*#__PURE__*/ React.createElement(
              "h1",
              {
                style: {
                  margin: 0,
                  font: "var(--text-display-md)",
                  letterSpacing: "var(--tracking-display)",
                },
              },
              "Reviews",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: "6px 0 0",
                  font: "var(--text-body)",
                  color: "var(--text-secondary)",
                },
              },
              "Everything patients are saying, in one place.",
            ),
          ),
          /*#__PURE__*/ React.createElement(Tabs, {
            value: tab,
            onChange: setTab,
            tabs: [
              {
                value: "all",
                label: "All reviews",
                count: d.reviews.length,
              },
              {
                value: "waiting",
                label: "Awaiting reply",
                count: waitingCount,
              },
              {
                value: "replied",
                label: "Replied",
              },
            ],
          }),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "flex",
                gap: 8,
              },
            },
            ["All sources", "Google", "Healthgrades"].map((s) =>
              /*#__PURE__*/ React.createElement(
                Tag,
                {
                  key: s,
                  selected: source === s,
                  onClick: () => setSource(s),
                },
                s,
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                display: "flex",
                flexDirection: "column",
                gap: 12,
              },
            },
            shown.map((r) => {
              const st = statusOf(r);
              return /*#__PURE__*/ React.createElement(
                Card,
                {
                  key: r.id,
                  padding: "18px 20px",
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginBottom: 8,
                    },
                  },
                  /*#__PURE__*/ React.createElement(RatingStars, {
                    rating: r.rating,
                    size: 14,
                  }),
                  /*#__PURE__*/ React.createElement(
                    "span",
                    {
                      style: {
                        font: "var(--text-body-strong)",
                        fontSize: 14,
                      },
                    },
                    r.author,
                  ),
                  /*#__PURE__*/ React.createElement(
                    "span",
                    {
                      style: {
                        font: "var(--text-small)",
                        color: "var(--text-tertiary)",
                      },
                    },
                    r.source,
                    " \xB7 ",
                    r.when,
                  ),
                  /*#__PURE__*/ React.createElement(
                    "span",
                    {
                      style: {
                        marginLeft: "auto",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                      },
                    },
                    st === "waiting" &&
                      /*#__PURE__*/ React.createElement(
                        Badge,
                        {
                          tone: "caution",
                        },
                        "Awaiting reply",
                      ),
                    st === "attention" &&
                      /*#__PURE__*/ React.createElement(
                        Badge,
                        {
                          tone: "negative",
                        },
                        "Needs attention",
                      ),
                    st === "replied" &&
                      /*#__PURE__*/ React.createElement(
                        Badge,
                        {
                          tone: "positive",
                        },
                        "Replied",
                      ),
                    st !== "replied" &&
                      /*#__PURE__*/ React.createElement(
                        Button,
                        {
                          size: "sm",
                          variant: "secondary",
                          onClick: () => openReply(r),
                        },
                        "Write reply",
                      ),
                  ),
                ),
                /*#__PURE__*/ React.createElement(
                  "p",
                  {
                    style: {
                      margin: 0,
                      font: "var(--text-quote)",
                      color: "var(--ink-800)",
                    },
                  },
                  "\u201C",
                  r.text,
                  "\u201D",
                ),
              );
            }),
            shown.length === 0 &&
              /*#__PURE__*/ React.createElement(
                Card,
                {
                  sunken: true,
                  padding: "28px",
                  style: {
                    textAlign: "center",
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "span",
                  {
                    style: {
                      font: "var(--text-body)",
                      color: "var(--text-secondary)",
                    },
                  },
                  "Nothing here right now.",
                ),
              ),
          ),
          /*#__PURE__*/ React.createElement(
            Dialog,
            {
              open: !!replying,
              onClose: () => setReplying(null),
              title: replying ? `Reply to ${replying.author}` : "",
              description:
                "Replies post publicly. A suggested draft is below \u2014 make it yours.",
              width: 560,
              footer: /*#__PURE__*/ React.createElement(
                React.Fragment,
                null,
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    variant: "secondary",
                    onClick: () => setReplying(null),
                  },
                  "Cancel",
                ),
                /*#__PURE__*/ React.createElement(
                  Button,
                  {
                    onClick: sendReply,
                  },
                  "Send reply",
                ),
              ),
            },
            replying &&
              /*#__PURE__*/ React.createElement(
                "div",
                {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  "div",
                  {
                    style: {
                      background: "var(--surface-sunken)",
                      borderRadius: "var(--radius-md)",
                      padding: 14,
                    },
                  },
                  /*#__PURE__*/ React.createElement(RatingStars, {
                    rating: replying.rating,
                    size: 13,
                  }),
                  /*#__PURE__*/ React.createElement(
                    "p",
                    {
                      style: {
                        margin: "8px 0 0",
                        font: "var(--text-quote)",
                        fontSize: 15,
                      },
                    },
                    "\u201C",
                    replying.text,
                    "\u201D",
                  ),
                ),
                /*#__PURE__*/ React.createElement("textarea", {
                  value: draft,
                  onChange: (e) => setDraft(e.target.value),
                  rows: 4,
                  style: {
                    font: "var(--text-body)",
                    color: "var(--text-primary)",
                    padding: "10px 12px",
                    resize: "vertical",
                    border: "1px solid var(--border-strong)",
                    borderRadius: "var(--radius-sm)",
                    outline: "none",
                  },
                }),
              ),
          ),
          toast &&
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  position: "fixed",
                  bottom: 24,
                  right: 24,
                  zIndex: 300,
                },
              },
              /*#__PURE__*/ React.createElement(Toast, {
                tone: "positive",
                message: toast.message,
                detail: toast.detail,
                onDismiss: () => setToast(null),
              }),
            ),
        );
      }
      Object.assign(window, {
        ReviewsScreen,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/app/ReviewsScreen.jsx",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/app/data.js
  try {
    (() => {
      // Mock data for the Well Regarded app UI kit.
      window.WR_DATA = {
        practice: {
          name: "Maple Street Dental",
          rating: 4.8,
          reviewCount: 132,
        },
        stats: [
          {
            label: "Average rating",
            value: "4.8",
            sub: "up from 4.6 this quarter",
          },
          {
            label: "Reviews this month",
            value: "14",
            sub: "9 from requests",
          },
          {
            label: "Awaiting reply",
            value: "3",
            sub: "oldest is 2 days old",
          },
          {
            label: "Requests sent",
            value: "42",
            sub: "31 opened",
          },
        ],
        reviews: [
          {
            id: 1,
            author: "Maria G.",
            rating: 5,
            source: "Google",
            when: "Yesterday",
            status: "waiting",
            text: "Dr. Aldana took the time to explain everything. I have never felt this at ease at a dentist.",
          },
          {
            id: 2,
            author: "Tom H.",
            rating: 4,
            source: "Google",
            when: "2 days ago",
            status: "waiting",
            text: "Friendly staff and easy scheduling. Waiting room ran a little behind, but the care was excellent.",
          },
          {
            id: 3,
            author: "Anonymous",
            rating: 2,
            source: "Healthgrades",
            when: "3 days ago",
            status: "attention",
            text: "Billing was confusing and nobody could explain my statement.",
          },
          {
            id: 4,
            author: "Priya S.",
            rating: 5,
            source: "Google",
            when: "Last week",
            status: "replied",
            text: "The hygienist was gentle and thorough. My kids actually look forward to their visits now.",
          },
          {
            id: 5,
            author: "Daniel R.",
            rating: 5,
            source: "Google",
            when: "Last week",
            status: "replied",
            text: "Been coming here for years. Consistently careful, honest work.",
          },
        ],
        requests: [
          {
            id: 1,
            patient: "Sofia Nguyen",
            visit: "Cleaning · Jul 8",
            channel: "Text",
            status: "Opened",
          },
          {
            id: 2,
            patient: "James Okafor",
            visit: "Crown · Jul 8",
            channel: "Text",
            status: "Sent",
          },
          {
            id: 3,
            patient: "Elena Petrov",
            visit: "Cleaning · Jul 7",
            channel: "Email",
            status: "Reviewed",
          },
          {
            id: 4,
            patient: "Marcus Webb",
            visit: "Filling · Jul 7",
            channel: "Text",
            status: "Opened",
          },
          {
            id: 5,
            patient: "Ana Lima",
            visit: "Checkup · Jul 3",
            channel: "Email",
            status: "Sent",
          },
        ],
      };
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/app/data.js",
      error: String((e && e.message) || e),
    });
  }

  // ui_kits/website/Sections.jsx
  try {
    (() => {
      // Marketing site sections: header, hero, how-it-works, quote band, footer.
      const { Button, RatingStars, Card, Badge } =
        window.WellRegardedDesignSystem_71432a;
      function SiteHeader() {
        return /*#__PURE__*/ React.createElement(
          "header",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 24,
              padding: "18px 40px",
              background: "var(--surface-page)",
              borderBottom: "1px solid var(--border-default)",
              position: "sticky",
              top: 0,
              zIndex: 50,
            },
          },
          /*#__PURE__*/ React.createElement(
            "span",
            {
              style: {
                font: "500 21px/1 var(--font-display)",
                letterSpacing: "var(--tracking-display)",
              },
            },
            "Well Regarded",
          ),
          /*#__PURE__*/ React.createElement(
            "nav",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 26,
              },
            },
            ["How it works", "Pricing", "For practices"].map((l) =>
              /*#__PURE__*/ React.createElement(
                "a",
                {
                  key: l,
                  href: "#",
                  onClick: (e) => e.preventDefault(),
                  style: {
                    font: "500 14px/1 var(--font-sans)",
                    textDecoration: "none",
                  },
                },
                l,
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                variant: "secondary",
                size: "sm",
              },
              "Sign in",
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                size: "sm",
              },
              "Get started",
            ),
          ),
        );
      }
      function Hero() {
        return /*#__PURE__*/ React.createElement(
          "section",
          {
            "data-screen-label": "Hero",
            style: {
              padding: "96px 40px 72px",
              background: "var(--surface-page)",
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                maxWidth: "var(--content-max)",
                margin: "0 auto",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 24,
                borderTop: "1px solid var(--ink-900)",
                paddingTop: 40,
              },
            },
            /*#__PURE__*/ React.createElement(
              "span",
              {
                style: {
                  font: "var(--text-label)",
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--accent-700)",
                },
              },
              "For dental practices",
            ),
            /*#__PURE__*/ React.createElement(
              "h1",
              {
                style: {
                  margin: 0,
                  font: "var(--text-display-xl)",
                  letterSpacing: "var(--tracking-display)",
                  maxWidth: 800,
                },
              },
              "Become the practice patients feel good recommending.",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: 0,
                  font: "var(--text-body)",
                  fontSize: 17,
                  color: "var(--text-secondary)",
                  maxWidth: 560,
                },
              },
              "Well Regarded automatically requests patient feedback, monitors your reviews, and helps your team respond thoughtfully.",
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  gap: 12,
                },
              },
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  size: "lg",
                },
                "Get started",
              ),
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  size: "lg",
                  variant: "secondary",
                },
                "See how it works",
              ),
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 8,
                },
              },
              /*#__PURE__*/ React.createElement(RatingStars, {
                rating: 4.8,
                size: 15,
              }),
              /*#__PURE__*/ React.createElement(
                "span",
                {
                  style: {
                    font: "var(--text-small)",
                    color: "var(--text-tertiary)",
                  },
                },
                "What a well-regarded profile looks like",
              ),
            ),
          ),
        );
      }
      function HowItWorks() {
        const steps = [
          {
            n: "01",
            title: "A thoughtful way to ask",
            body: "After each visit, patients receive one considerate message. No nagging, no incentives — just a simple invitation to share.",
          },
          {
            n: "02",
            title: "Everything in one place",
            body: "Reviews from Google and beyond arrive in a single quiet inbox, so nothing sits unanswered for weeks.",
          },
          {
            n: "03",
            title: "Respond like yourself",
            body: "Suggested replies start the sentence; your team finishes it. Every response sounds like your practice, not a template.",
          },
        ];
        return /*#__PURE__*/ React.createElement(
          "section",
          {
            "data-screen-label": "How it works",
            style: {
              padding: "72px 40px",
              background: "var(--surface-card)",
              borderTop: "1px solid var(--border-default)",
              borderBottom: "1px solid var(--border-default)",
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                maxWidth: "var(--content-max)",
                margin: "0 auto",
              },
            },
            /*#__PURE__*/ React.createElement(
              "h2",
              {
                style: {
                  margin: "0 0 40px",
                  font: "var(--text-display-lg)",
                  letterSpacing: "var(--tracking-display)",
                },
              },
              "Good care earns a good reputation.",
              /*#__PURE__*/ React.createElement("br", null),
              "Well Regarded helps it travel.",
            ),
            /*#__PURE__*/ React.createElement(
              "div",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 20,
                },
              },
              steps.map((s) =>
                /*#__PURE__*/ React.createElement(
                  Card,
                  {
                    key: s.n,
                    padding: "24px",
                  },
                  /*#__PURE__*/ React.createElement(
                    "div",
                    {
                      style: {
                        font: "500 13px/1 var(--font-mono)",
                        color: "var(--accent-700)",
                        letterSpacing: "var(--tracking-label)",
                      },
                    },
                    s.n,
                  ),
                  /*#__PURE__*/ React.createElement(
                    "h3",
                    {
                      style: {
                        margin: "12px 0 8px",
                        font: "var(--text-display-sm)",
                        letterSpacing: "var(--tracking-display)",
                      },
                    },
                    s.title,
                  ),
                  /*#__PURE__*/ React.createElement(
                    "p",
                    {
                      style: {
                        margin: 0,
                        font: "var(--text-body)",
                        color: "var(--text-secondary)",
                      },
                    },
                    s.body,
                  ),
                ),
              ),
            ),
          ),
        );
      }
      function QuoteBand() {
        return /*#__PURE__*/ React.createElement(
          "section",
          {
            "data-screen-label": "Quote band",
            style: {
              padding: "80px 40px",
              background: "var(--ink-900)",
              color: "var(--text-on-dark)",
              textAlign: "center",
            },
          },
          /*#__PURE__*/ React.createElement(
            "div",
            {
              style: {
                maxWidth: 720,
                margin: "0 auto",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 18,
              },
            },
            /*#__PURE__*/ React.createElement(
              "blockquote",
              {
                style: {
                  margin: 0,
                  font: "500 28px/1.4 var(--font-display)",
                  letterSpacing: "var(--tracking-display)",
                },
              },
              "\u201CThe patients who appreciate you are often the ones least likely to remember to leave a review.\u201D",
            ),
            /*#__PURE__*/ React.createElement(
              "p",
              {
                style: {
                  margin: 0,
                  font: "var(--text-data)",
                  color: "var(--accent-500)",
                  maxWidth: 520,
                },
              },
              "Your practice is already well regarded. Your Google profile should show it.",
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                size: "lg",
                style: {
                  background: "var(--white)",
                  color: "var(--ink-900)",
                  border: "1px solid var(--white)",
                  marginTop: 6,
                },
              },
              "Get started",
            ),
          ),
        );
      }
      function SiteFooter() {
        return /*#__PURE__*/ React.createElement(
          "footer",
          {
            style: {
              padding: "40px",
              background: "var(--surface-page)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 24,
            },
          },
          /*#__PURE__*/ React.createElement(
            "span",
            {
              style: {
                font: "500 17px/1 var(--font-display)",
              },
            },
            "Well Regarded",
          ),
          /*#__PURE__*/ React.createElement(
            "nav",
            {
              style: {
                display: "flex",
                gap: 22,
              },
            },
            ["Privacy", "Terms", "Contact"].map((l) =>
              /*#__PURE__*/ React.createElement(
                "a",
                {
                  key: l,
                  href: "#",
                  onClick: (e) => e.preventDefault(),
                  style: {
                    font: "var(--text-small)",
                    textDecoration: "none",
                    color: "var(--text-secondary)",
                  },
                },
                l,
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement(
            "span",
            {
              style: {
                font: "var(--text-small)",
                color: "var(--text-tertiary)",
              },
            },
            "\xA9 2026 Well Regarded",
          ),
        );
      }
      Object.assign(window, {
        SiteHeader,
        Hero,
        HowItWorks,
        QuoteBand,
        SiteFooter,
      });
    })();
  } catch (e) {
    __ds_ns.__errors.push({
      path: "ui_kits/website/Sections.jsx",
      error: String((e && e.message) || e),
    });
  }

  __ds_ns.Button = __ds_scope.Button;

  __ds_ns.IconButton = __ds_scope.IconButton;

  __ds_ns.Badge = __ds_scope.Badge;

  __ds_ns.Card = __ds_scope.Card;

  __ds_ns.RatingStars = __ds_scope.RatingStars;

  __ds_ns.Tag = __ds_scope.Tag;

  __ds_ns.Checkbox = __ds_scope.Checkbox;

  __ds_ns.Input = __ds_scope.Input;

  __ds_ns.RadioGroup = __ds_scope.RadioGroup;

  __ds_ns.Select = __ds_scope.Select;

  __ds_ns.Switch = __ds_scope.Switch;

  __ds_ns.Tabs = __ds_scope.Tabs;

  __ds_ns.Dialog = __ds_scope.Dialog;

  __ds_ns.Toast = __ds_scope.Toast;

  __ds_ns.Tooltip = __ds_scope.Tooltip;
})();
