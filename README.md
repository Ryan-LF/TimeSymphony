# 时之交响 TimeSymphony

H5 时钟图标动画。纯原生 JS + Canvas 2D，无构建步骤、无第三方依赖、零外链，`file://` 直接打开即可运行。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | **主入口**。单页，两档画质可切换 |
| `assets/icon.js` | 图标动画引擎，`window.TimeSymphonyIcon.create(canvas, opts)` |
| `assets/icon.css` | 页面样式（深色舞台是这个图标的设计前提） |
| `icon_v1_blur.html` | 原始设计稿 A：1314 颗粒子 + 逐粒子高斯发光 |
| `icon_v2_sprite.html` | 原始设计稿 B：950 颗粒子 + 预渲染位图发光 |

两份原始稿保留作为对照，不再更新。所有改动请落在 `index.html` + `assets/`。

## 两档画质

两档共用同一套绘制逻辑，只在**粒子数量**和**发光实现**上不同：

| 档位 | 粒子 | 发光 | 适用 |
|---|---|---|---|
| 高清 `hd` | 1314 | `ctx.shadowBlur`，逐粒子高斯 | 独显 / 台式机，观感最厚 |
| 流畅 `smooth`（默认） | 950 | 预渲染径向渐变位图 + `drawImage` | 核显 / 展台机 / 老笔记本 |

`shadowBlur` 是逐粒子高斯模糊，1314 颗会把帧率打穿；位图方案把成本压到 `drawImage` 级别。

默认 `smooth` 是有意的：现场展台机和评委手机大概率是核显，宁可少 28% 粒子也不能掉帧。
需要最厚观感时由使用者手动切「高清」。

## 用法

```js
var icon = TimeSymphonyIcon.create(document.getElementById('canvas'), {
  stage: document.getElementById('stage'), // 用来量尺寸的容器，缺省取 canvas.parentElement
  quality: 'smooth'                        // 'hd' | 'smooth'
});

icon.setQuality('hd');   // 运行时切档，返回实际生效的档位
icon.destroy();          // 停掉 rAF 与 resize 监听
```

## 改样式/脚本前必读

- `index.html` 里 `assets/icon.css?v=` 与 `assets/icon.js?v=` **两处版本号必须同改**，
  否则浏览器会拿旧缓存，改了看不到效果。
- 静态资源改动后同步递增 `?v=YYYYMMDD`。
- 粒子尺寸以 `R()`（画布 42%）的比例存储，绘制时才乘回像素——**不要**在粒子对象里存绝对像素，
  否则窗口缩放后粒子半径不跟随。
