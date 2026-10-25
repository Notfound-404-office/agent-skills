# 404 u32 电路

当前维护的新版电路工作区。历史 u8 阅读包和原始产物保留在 `../review/`、`../transfer.json` 和 `../hold.json`，不再覆盖它们。

- transfer 的公开资产编号为 `u32`，保留单资产、2 输入、2 输出、`u64` 金额。
- commitment 仍为 `Poseidon2(D_NOTE, value + asset * 2^64, inner)`；资产和金额占用不重叠。
- hold 仍只证明 404（编号 0）；发布脚本要求其 ABI 和解压 ACIR 与历史版本一致。
- 新 note 明文版本 3，资产字段为 4 字节大端；明文 127 字节，密文 175 字节。SDK 可以读取历史 v2，但新合约只接收新版密文。

在仓库根目录运行：

```sh
node bsc-deploy/source-core/scripts/compile-circuits.mjs
node bsc-deploy/source-core/scripts/build.mjs
```

编译使用固定 Noir `1.0.0-beta.25`，可用 `PROTOCOL404_NARGO` 指向同版本编译器。脚本只在编译成功后发布去除调试路径的 `transfer.json`、浏览器模块和配套 VK/Solidity verifier；不签名或广播交易。Nargo 需要写入其常规 `~/nargo/.package-cache`，仅允许写项目目录的沙箱会阻止此步骤。

当前升级状态及验证缺口见 `bsc-deploy/source-core/U32_UPGRADE.md`。编号宽度升级不等于资产注册功能：当前 Pool 的业务入口仍只接受 0 和 1。
