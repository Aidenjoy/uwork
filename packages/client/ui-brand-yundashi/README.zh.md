---
description: "云大师 Agent 侧栏与空白首页品牌图形。"
kind: "package-reference"
---

# @yundashi/dsh-client-ui-brand

[English](README.md) | 中文

## 概述

本包负责云大师 Agent 的浏览器品牌身份：占据侧栏品牌槽位、首页标志槽位与首页 frame 层，确保默认装饰图形不会出现。图形裁切自云大师官网截图，没有矢量源文件。

## 使用本包

装配本包替代官方品牌包。占据 slot 是唯一的组合路径，品牌身份不可配置。

## 构建

浏览器标题是构建期取值，不属于 slot。构建 Web 客户端时只覆盖标题，不设置任何 client profile：

```sh
DSH_CLIENT_TITLE="云大师 Agent" pnpm dsh web
```

不要设置 `DSH_BUILD_CLIENT_PROFILE`：named profile 会丢弃继承的标题覆盖，official profile 还会写死自己的标题。

## 已知限制

图形仅有位图版本。favicon 与安装包素材位于 Web 与 Desktop 应用中，不在本包内。
