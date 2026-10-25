# Noir 电路逐行阅读

本文按导出文件的**原行号**解释源码。空行略过；每条非空业务代码、注释和结构闭合行都在表中出现。这里先解释电路约束，再解释共享哈希，避免底层细节遮住业务规则。

## 先认识几种写法

| 写法 | 阅读方式 |
|---|---|
| `Field` | 有限域里的数；其运算按固定的大质数取模，不等同于任意精度整数 |
| `u8`、`u32`、`u64`、`u128` | 对应位数的无符号整数；例如 `u64` 的范围是 0 到 `2^64 - 1` |
| `x: pub Field` | 参数 `x` 是公开输入，验证者会拿到它 |
| `x: Field` | 这里的入口参数 `x` 是私有输入，供证明者生成 witness |
| `pub fn`、`pub mod` | 函数或模块可被其他模块调用，不表示函数的参数都会上链公开 |
| `[Field; 2]` | 长度固定为 2 的数组；电路的输入槽位数量在编译时确定 |
| `assert(...)`、`assert_eq(a, b)` | 加入必须满足的条件；分别表示条件为真、`a` 必须等于 `b` |
| `let mut`、`as u128` | 声明可更新的变量、把数值转换为 `u128` 类型 |

## 电路实际保证什么

### Transfer

`transfer` 证明：同一种 `asset` 的最多两张有效输入票据，由 `sk`、`nk` 对应的 owner 控制；非零输入属于公开的 Merkle `root` 且已经解锁；两个公开 nullifier 来自对应输入位置；两个公开输出 commitment 与秘密输出字段一致；输入总额等于两个秘密输出、`public_out` 和 `fee` 之和。

边界必须一起读：

- 零金额输入是 dummy。它仍计算 commitment、location 和 nullifier，但不验证 Merkle 成员关系，也不验证锁定时间。
- 电路只要求本次的两个 nullifier 不同。跨交易的全局双花防护由 Pool 查询并记录已用 nullifier 完成，不在此电路内完成。
- `ext_hash` 在 `main` 函数体内没有 `assert` 或哈希重算。现有设计依赖 UltraHonk 把该公共输入绑定进证明，并依赖合约按外部数据重算后核对；这条组合边界需要单独审计，本文不据此宣称设计已证明安全。
- 求和先把每个 `u64` 转成 `u128`，避免两个输入或多个输出在 `u64` 加法中溢出。
- 电路让所有输入、输出、公开转出和手续费共享同一 `asset`，但 `u8` 本身没有被约束为只有 0 或 1；允许的资产编号还取决于电路外协议。

### Hold

`hold` 证明：在给定 `root` 中，至多四张非零、asset 0（404 token；404 语境中的协议资产）的票据总额达到 `threshold`，每张票据的 `lock` 不小于 `min_lock`，且同一张非零票据不会在一份证明内重复计数。公开 tag 与票据位置、`nk` 和活动编号相符。

它没有独立查询当前 nullifier 是否已被使用。因此准确说法是“证明给定 root 中存在足量、满足锁定字段的票据”，不能无条件说成“证明当前可花余额”或“证明票据目前一定未花费”。`binding` 在函数体内没有业务表达式，只作为公共输入由证明系统绑定；其业务含义仍需外层协议核对。零金额槽位不验证 commitment、Merkle 路径或锁定时间，只要求非零 dummy 随机数并生成 dummy tag。

## `transfer/src/main.nr`

| 原行号 | 原代码 | 中文解释 |
|---:|---|---|
| 1 | `// SPEC 6.1: 2-in-2-out private transfer of one asset, optional unshield (public_out) and relayer fee.` | 文件目标：同一资产的两输入、两输出私密转账，可选公开转出和 relayer 手续费。 |
| 2 | `use pm_lib::{commitment, inner, location, merkle_root, nk_commit, nullifier, owner, spend_pub, TREE_DEPTH};` | 导入共享的票据哈希、位置、nullifier、Merkle 根和树深度定义。 |
| 4 | `fn main(` | 定义电路入口；参数是否带 `pub` 决定公开输入或秘密 witness。 |
| 5 | `root: pub Field,` | 公开 Merkle 根，非零输入必须证明属于这棵树。 |
| 6 | `nullifiers: pub [Field; 2],` | 两个公开 nullifier，Pool 可用它们执行全局已花检查。 |
| 7 | `commitments: pub [Field; 2],` | 两个公开输出 commitment；输出明文仍为秘密。 |
| 8 | `now: pub u64,` | 公开时间值，用于判断非零输入是否已经解锁。 |
| 9 | `// Every note of the transaction holds this asset; public_out and fee are paid in it too.` | 说明输入、输出、公开转出和手续费都使用同一资产编号。 |
| 10 | `asset: pub u8,` | 公开资产编号；电路内未另行限制可用编号集合。 |
| 11 | `public_out: pub u64,` | 公开转出金额，例如从私密池取到公开地址的金额。 |
| 12 | `fee: pub u64,` | 公开 relayer 手续费金额。 |
| 13 | `// Hash of recipient, relayer, caller, app data, ciphertexts, chain and pool. Unused in` | 注释列出 `ext_hash` 预期承诺的外部交易上下文。 |
| 14 | `// constraints: UltraHonk binds every public input to the proof (checked by the tamper tests).` | 注释称证明系统绑定公共输入；但电路体不重算该哈希，合约重算边界仍须单独核验。 |
| 15 | `ext_hash: pub Field,` | 公开外部数据哈希；在本函数体内没有被读取。 |
| 16 | `sk: Field,` | 秘密 spending key，必须非零，用于派生 `spk`。 |
| 17 | `nk: Field,` | 秘密 nullifier key，必须非零，用于 owner 关系和 nullifier。 |
| 18 | `in_value: [u64; 2],` | 两张输入票据的秘密金额；零金额表示 dummy 槽位。 |
| 19 | `in_d: [Field; 2],` | 两张输入的秘密 owner 派生因子 `d`。 |
| 20 | `in_lock: [u64; 2],` | 两张输入的秘密解锁时间。 |
| 21 | `in_rcm: [Field; 2],` | 两张输入的秘密 commitment 随机量。 |
| 22 | `in_index: [u32; 2],` | 两张输入在深度 32 Merkle 树中的秘密叶索引。 |
| 23 | `in_path: [[Field; TREE_DEPTH]; 2],` | 两条秘密 Merkle 认证路径，每条有 `TREE_DEPTH` 个兄弟节点。 |
| 24 | `out_value: [u64; 2],` | 两张输出票据的秘密金额。 |
| 25 | `out_owner: [Field; 2],` | 两张输出的秘密 owner 字段；公开的是其 commitment。 |
| 26 | `out_lock: [u64; 2],` | 两张输出的秘密锁定时间。 |
| 27 | `out_rcm: [Field; 2],` | 两张输出的秘密 commitment 随机量。 |
| 28 | `) {` | 参数结束，进入约束主体。 |
| 29 | `assert(sk != 0);` | 拒绝零 spending key。 |
| 30 | `assert(nk != 0);` | 拒绝零 nullifier key。 |
| 31 | `let spk = spend_pub(sk);` | 用带域哈希从 `sk` 派生 spending public value。 |
| 32 | `let nkc = nk_commit(nk);` | 用带域哈希承诺 `nk`，供 owner 派生使用。 |
| 34 | `let mut total_in: u128 = 0;` | 用 `u128` 初始化输入总额，给两个 `u64` 相加留足空间。 |
| 35 | `for i in 0..2 {` | 依次约束两个输入槽位。 |
| 36 | `let cm = commitment(asset, in_value[i], inner(owner(spk, nkc, in_d[i]), in_lock[i], in_rcm[i]));` | 从公开资产和秘密 owner、金额、锁定、随机量重建第 `i` 张输入 commitment。 |
| 37 | `// Every slot publishes a nullifier; a zero-value dummy's looks just as random.` | 每个槽位都产生公开 nullifier，包括零金额 dummy。 |
| 38 | `assert_eq(nullifiers[i], nullifier(nk, location(cm, in_index[i])));` | 要求公开 nullifier 等于由 `nk`、重建 commitment 和叶索引计算的值。 |
| 39 | `if in_value[i] != 0 {` | 只有非零真实输入进入成员关系和解锁检查。 |
| 40 | `assert_eq(merkle_root(cm, in_index[i], in_path[i]), root);` | 沿秘密路径重算根，并要求等于公开 `root`。 |
| 41 | `assert(in_lock[i] <= now);` | 要求输入锁定时间不晚于公开 `now`，即已经解锁。 |
| 42 | `}` | 结束非零输入分支；dummy 跳过前两项检查。 |
| 43 | `total_in += in_value[i] as u128;` | 把金额转成 `u128` 后累加；dummy 贡献 0。 |
| 44 | `}` | 结束两个输入的循环。 |
| 45 | `assert(nullifiers[0] != nullifiers[1]);` | 禁止本次两个槽位产生同一 nullifier；不替代 Pool 的跨交易检查。 |
| 47 | `let mut total_out: u128 = (public_out as u128) + (fee as u128);` | 先把公开转出与手续费转成 `u128` 并计入输出侧。 |
| 48 | `for j in 0..2 {` | 依次约束两个输出槽位。 |
| 49 | `assert_eq(commitments[j], commitment(asset, out_value[j], inner(out_owner[j], out_lock[j], out_rcm[j])));` | 从秘密输出字段重建 commitment，并要求等于第 `j` 个公开 commitment。 |
| 50 | `total_out += out_value[j] as u128;` | 把第 `j` 个秘密输出金额转成 `u128` 后累加。 |
| 51 | `}` | 结束两个输出的循环。 |
| 52 | `assert_eq(total_in, total_out);` | 金额守恒：输入总额 = 两个输出 + 公开转出 + 手续费。 |
| 53 | `}` | 结束 transfer 电路入口。 |

## `hold/src/main.nr`

| 原行号 | 原代码 | 中文解释 |
|---:|---|---|
| 1 | <code>// SPEC 6.2: prove at least `threshold` 404 token locked until at least `min_lock`, using up to 4 notes.</code> | 文件目标：用最多四张票据证明至少 `threshold` 数量的 404 token 锁定到不早于 `min_lock`。 |
| 2 | `use pm_lib::{commitment, dummy_tag, hold_tag, inner, location, merkle_root, nk_commit, owner, spend_pub, TREE_DEPTH};` | 导入共享的票据、tag、位置、Merkle 根和密钥派生函数。 |
| 4 | `fn main(` | 定义 hold 电路入口。 |
| 5 | `root: pub Field,` | 公开 Merkle 根，非零票据必须属于该根。 |
| 6 | `threshold: pub u64,` | 公开最低持有量；最终秘密金额总和必须达到它。 |
| 7 | `min_lock: pub u64,` | 公开最低锁定时间；每张非零票据的 `lock` 不得更小。 |
| 8 | `campaign_id: pub Field,` | 公开活动编号，参与 hold tag 和 dummy tag 的域内计算。 |
| 9 | `// Claim address or challenge; bound to the proof as a public input.` | 说明 `binding` 可承载领取地址或 challenge，并作为公共输入绑定。 |
| 10 | `binding: pub Field,` | 公开绑定值；函数体没有进一步计算或断言它。 |
| 11 | `tags: pub [Field; 4],` | 四个公开 tag；真实槽位用 hold tag，dummy 槽位用 dummy tag。 |
| 12 | `sk: Field,` | 秘密 spending key，必须非零。 |
| 13 | `nk: Field,` | 秘密 nullifier key，必须非零；用于 owner 和真实 tag。 |
| 14 | `value: [u64; 4],` | 四个秘密金额；零值表示 dummy 槽位。 |
| 15 | `d: [Field; 4],` | 四张票据的秘密 owner 派生因子。 |
| 16 | `lock: [u64; 4],` | 四张票据的秘密锁定时间。 |
| 17 | `rcm: [Field; 4],` | 四张票据的秘密 commitment 随机量。 |
| 18 | `index: [u32; 4],` | 四张票据的秘密 Merkle 叶索引。 |
| 19 | `path: [[Field; TREE_DEPTH]; 4],` | 四条秘密 Merkle 认证路径。 |
| 20 | `dummy_r: [Field; 4],` | dummy 槽位生成不可混同 tag 所用的秘密随机量。 |
| 21 | `) {` | 参数结束，进入约束主体。 |
| 22 | `assert(sk != 0);` | 拒绝零 spending key。 |
| 23 | `assert(nk != 0);` | 拒绝零 nullifier key。 |
| 24 | `assert(threshold != 0);` | 拒绝零门槛，避免没有实际持有量要求的证明。 |
| 25 | `let spk = spend_pub(sk);` | 从秘密 `sk` 派生 spending public value。 |
| 26 | `let nkc = nk_commit(nk);` | 承诺秘密 `nk`，供 owner 派生。 |
| 28 | `let mut locs: [Field; 4] = [0; 4];` | 初始化四个位置缓存；只有真实槽位会写入位置。 |
| 29 | `let mut total: u128 = 0;` | 用 `u128` 初始化总金额，避免四个 `u64` 求和溢出。 |
| 30 | `for i in 0..4 {` | 依次处理四个槽位。 |
| 31 | `if value[i] != 0 {` | 非零金额走真实票据分支。 |
| 32 | `// 404 token notes only (asset 0): other assets do not count toward a holding.` | 只把 asset 0 的协议票据计入持有量。 |
| 33 | `let cm = commitment(0, value[i], inner(owner(spk, nkc, d[i]), lock[i], rcm[i]));` | 用固定 asset 0 和秘密票据字段重建 commitment。 |
| 34 | `assert_eq(merkle_root(cm, index[i], path[i]), root);` | 验证重建 commitment 属于公开 `root`。 |
| 35 | `// Locked past min_lock, so it cannot have been spent while the campaign is open.` | 源注释给出设计意图；单靠本电路并未查询当前已用 nullifier 集合。 |
| 36 | `assert(lock[i] >= min_lock);` | 要求票据锁定字段不小于公开最低锁定时间。 |
| 37 | `let loc = location(cm, index[i]);` | 用 commitment 和叶索引派生唯一位置值。 |
| 38 | `assert_eq(tags[i], hold_tag(nk, loc, campaign_id));` | 要求公开 tag 与秘密 `nk`、票据位置和活动编号一致。 |
| 39 | `locs[i] = loc;` | 保存真实票据位置，稍后检查重复计数。 |
| 40 | `} else {` | 零金额槽位进入 dummy 分支。 |
| 41 | `assert(dummy_r[i] != 0);` | dummy 随机量必须非零。 |
| 42 | `assert_eq(tags[i], dummy_tag(dummy_r[i], campaign_id));` | 要求公开 tag 等于 dummy 随机量和活动编号的带域哈希。 |
| 43 | `}` | 结束真实/dummy 分支。dummy 不验证 commitment、路径或 lock。 |
| 44 | `total += value[i] as u128;` | 把金额转成 `u128` 后累加；dummy 贡献 0。 |
| 45 | `}` | 结束四个槽位的循环。 |
| 46 | `// The same note may not be counted twice in one proof.` | 下面检查一份证明内不能重复使用同一张真实票据。 |
| 47 | `for i in 0..4 {` | 枚举第一个槽位。 |
| 48 | `for j in 0..4 {` | 枚举第二个槽位。 |
| 49 | `if (i < j) & (value[i] != 0) & (value[j] != 0) {` | 只比较顺序不同的真实槽位对；`&` 组合三个布尔条件。 |
| 50 | `assert(locs[i] != locs[j]);` | 要求两张真实票据的位置不同，防止本证明内重复计数。 |
| 51 | `}` | 结束条件分支。 |
| 52 | `}` | 结束内层 `j` 循环。 |
| 53 | `}` | 结束外层 `i` 循环。 |
| 54 | `assert(total >= threshold as u128);` | 要求秘密票据总额至少达到转为 `u128` 的公开门槛。 |
| 55 | `}` | 结束 hold 电路入口。 |

## `pm_lib/src/lib.nr`

这一层定义业务哈希关系。可按下面的链条理解一张输入票据：

```text
sk ──spend_pub──> spk
nk ──nk_commit──> nkc
(spk, nkc, d) ──owner──> owner
(owner, lock, rcm) ──inner──> inner
(asset, value, inner) ──commitment──> cm
(cm, leaf_index) ──location──> loc
(nk, loc) ──nullifier──> nf
```

| 原行号 | 原代码 | 中文解释 |
|---:|---|---|
| 1 | `// Shared note relations (SPEC 4.4, 4.5, 4.7). Every hash is a Poseidon2 sponge of 2 to 4 inputs.` | 本文件集中定义票据关系；每个业务哈希最终调用 2～4 输入的 Poseidon2 海绵。 |
| 2 | `pub mod hash;` | 公开 `hash` 子模块。 |
| 3 | `pub mod domains;` | 公开 `domains` 子模块。 |
| 5 | `use hash::{h2, h3, h4};` | 导入 2、3、4 输入哈希封装。 |
| 6 | `use domains::{D_INNER, D_LOC, D_NF, D_NKC, D_NOTE, D_OWNER, D_SPEND, D_TAG, D_TAG_DUMMY};` | 导入各业务用途的公开域分隔常量。 |
| 8 | `pub global TREE_DEPTH: u32 = 32;` | Merkle 树固定深度为 32。 |
| 9 | `/// Asset ids: 0 = 404 token (the pool's token), 1 = the native coin (OKB) in units of 1e-8.` | 原协议注释：0 表示池代币 404 token，1 表示按 `1e-8` 计量的原生币 OKB。404 的链与品牌适配属于电路外配置核对事项。 |
| 10 | `pub global ASSET_SHIFT: Field = 18446744073709551616; // 2^64` | 资产编号左移 64 位所用的常量，即 `2^64`。 |
| 12 | `pub fn spend_pub(sk: Field) -> Field {` | 定义从 spending key 派生 Field 值的函数。 |
| 13 | `h2([D_SPEND, sk])` | 计算 `H(D_SPEND, sk)`；域常量把用途隔离为 spending-key 派生。 |
| 14 | `}` | 结束 `spend_pub`。 |
| 16 | `pub fn nk_commit(nk: Field) -> Field {` | 定义 nullifier key commitment。 |
| 17 | `h2([D_NKC, nk])` | 计算 `H(D_NKC, nk)`。 |
| 18 | `}` | 结束 `nk_commit`。 |
| 20 | `pub fn owner(spend_pub: Field, nkc: Field, d: Field) -> Field {` | 定义 owner 字段，由 spending public value、`nk` commitment 和派生因子 `d` 组成。 |
| 21 | `h4([D_OWNER, spend_pub, nkc, d])` | 计算带 `D_OWNER` 域的四输入哈希。 |
| 22 | `}` | 结束 `owner`。 |
| 24 | `pub fn inner(owner: Field, lock_until: u64, rcm: Field) -> Field {` | 定义票据内部承诺，纳入 owner、锁定时间和随机量。 |
| 25 | `h4([D_INNER, owner, lock_until as Field, rcm])` | 把 `u64` 锁定时间转成 Field，再计算带域四输入哈希。 |
| 26 | `}` | 结束 `inner`。 |
| 28 | `/// The asset rides above the 64-bit value in one field element, so the contract still hashes three` | 说明资产编号和 64 位金额被打包进同一个 Field。 |
| 29 | `/// inputs; asset 0 gives exactly P3(D_NOTE, value, inner).` | asset 0 时打包值就是金额，因此形式为 `H(D_NOTE, value, inner)`。 |
| 30 | `pub fn commitment(asset: u8, value: u64, inner: Field) -> Field {` | 定义完整票据 commitment。 |
| 31 | `h3([D_NOTE, value as Field + (asset as Field) * ASSET_SHIFT, inner])` | 计算 `H(D_NOTE, value + asset×2^64, inner)`，使资产编号位于金额上方。 |
| 32 | `}` | 结束 `commitment`。 |
| 34 | `pub fn location(cm: Field, leaf_index: u32) -> Field {` | 定义票据位置值，组合 commitment 和叶索引。 |
| 35 | `h3([D_LOC, cm, leaf_index as Field])` | 把索引转成 Field，计算带 `D_LOC` 域的哈希。 |
| 36 | `}` | 结束 `location`。 |
| 38 | `pub fn nullifier(nk: Field, loc: Field) -> Field {` | 定义 nullifier；同一 `nk` 和位置会得到确定结果。 |
| 39 | `h3([D_NF, nk, loc])` | 计算 `H(D_NF, nk, loc)`。 |
| 40 | `}` | 结束 `nullifier`。 |
| 42 | `pub fn hold_tag(nk: Field, loc: Field, campaign_id: Field) -> Field {` | 定义真实 hold 票据的活动 tag。 |
| 43 | `h4([D_TAG, nk, loc, campaign_id])` | 计算 `H(D_TAG, nk, loc, campaign_id)`。 |
| 44 | `}` | 结束 `hold_tag`。 |
| 46 | `pub fn dummy_tag(r: Field, campaign_id: Field) -> Field {` | 定义零金额 dummy 槽位的活动 tag。 |
| 47 | `h3([D_TAG_DUMMY, r, campaign_id])` | 计算 `H(D_TAG_DUMMY, r, campaign_id)`，与真实 tag 使用不同域。 |
| 48 | `}` | 结束 `dummy_tag`。 |
| 50 | <code>/// Bit i of `index` says whether the node at depth i is a right child.</code> | 规定索引第 `i` 位表示当前节点在第 `i` 层是否为右子节点。 |
| 51 | `pub fn merkle_root(leaf: Field, index: u32, path: [Field; TREE_DEPTH]) -> Field {` | 定义从叶、索引和 32 个兄弟节点重建 Merkle 根。 |
| 52 | `let mut current = leaf;` | 从叶值开始向上计算。 |
| 53 | `for i in 0..TREE_DEPTH {` | 逐层处理 32 个兄弟节点。 |
| 54 | `let right = ((index >> i) & 1) == 1;` | 读取索引第 `i` 位，判断当前值是否位于右侧。 |
| 55 | `current = h2(if right { [path[i], current] } else { [current, path[i]] });` | 若当前值在右侧则兄弟在前，否则当前值在前；按正确顺序哈希父节点。 |
| 56 | `}` | 结束逐层循环。 |
| 57 | `current` | 返回最终重建出的根。 |
| 58 | `}` | 结束 `merkle_root`。 |

## `pm_lib/src/hash.nr`

这里实现的是 BN254、状态宽度 `t = 4`、吸收速率 3 的 Poseidon2 海绵封装。它调用 Noir 标准库的 `poseidon2_permutation` 黑盒；阅读业务电路时无需继续展开标准库置换内部的轮常量和矩阵运算。

| 原行号 | 原代码 | 中文解释 |
|---:|---|---|
| 1 | `// Poseidon2 sponge (BN254, t = 4, rate 3) over the stdlib permutation black box, the same` | 说明使用 BN254 上、四元素状态、每轮吸收三个元素的 Poseidon2 海绵。 |
| 2 | `// construction as Barretenberg's poseidon2 hash and poseidon2-evm: the capacity element starts at` | 说明构造目标与 Barretenberg / poseidon2-evm 的约定一致。 |
| 3 | `// len * 2^64, inputs are absorbed three at a time, and the output is state[0].` | 容量元素以 `输入长度×2^64` 初始化，每次吸收三个元素，输出状态第 0 项。 |
| 4 | `global TWO_POW_64: Field = 18446744073709551616;` | 定义 Field 中的 `2^64` 常量，用于把输入长度放进容量元素。 |
| 6 | `fn sponge<let N: u32>(input: [Field; N]) -> Field {` | 定义编译期长度为 `N` 的通用海绵函数。 |
| 7 | `let mut state: [Field; 4] = [0, 0, 0, (N as Field) * TWO_POW_64];` | 初始化四元素状态；前三项为 0，容量项编码输入长度。 |
| 8 | `let mut cache: [Field; 3] = [0; 3];` | 初始化三元素吸收缓存。 |
| 9 | `let mut size: u32 = 0;` | 记录缓存中已有多少个输入。 |
| 10 | `for i in 0..N {` | 依次读取全部输入 Field。 |
| 11 | `if size == 3 {` | 若上一批缓存已经装满三个元素，先吸收并置换。 |
| 12 | `for j in 0..3 {` | 遍历三个 rate 位置。 |
| 13 | `state[j] += cache[j];` | 把缓存逐项加到状态前三项。 |
| 14 | `}` | 结束三个 rate 位置的累加。 |
| 15 | `state = std::hash::poseidon2_permutation(state);` | 调用 Noir 标准库 Poseidon2 置换更新整个状态。 |
| 16 | `cache = [0; 3];` | 清空吸收缓存。 |
| 17 | `size = 0;` | 把缓存计数重置为 0。 |
| 18 | `}` | 结束满缓存处理。 |
| 19 | `cache[size] = input[i];` | 把当前输入写入下一个缓存位置。 |
| 20 | `size += 1;` | 增加缓存计数。 |
| 21 | `}` | 结束输入循环。 |
| 22 | `for j in 0..3 {` | 遍历缓存位置，吸收最后一批未处理输入。 |
| 23 | `if j < size {` | 只处理实际装有输入的缓存项。 |
| 24 | `state[j] += cache[j];` | 把剩余缓存项加到对应状态项。 |
| 25 | `}` | 结束有效缓存项条件。 |
| 26 | `}` | 结束最后一批的三个位置循环。 |
| 27 | `state = std::hash::poseidon2_permutation(state);` | 对吸收完的最终状态再执行一次置换。 |
| 28 | `state[0]` | 返回置换后状态第 0 项作为哈希结果。 |
| 29 | `}` | 结束 `sponge`。 |
| 31 | `pub fn h2(input: [Field; 2]) -> Field {` | 公开固定两个输入的哈希接口。 |
| 32 | `sponge(input)` | 用 `N = 2` 调用海绵。 |
| 33 | `}` | 结束 `h2`。 |
| 35 | `pub fn h3(input: [Field; 3]) -> Field {` | 公开固定三个输入的哈希接口。 |
| 36 | `sponge(input)` | 用 `N = 3` 调用海绵。 |
| 37 | `}` | 结束 `h3`。 |
| 39 | `pub fn h4(input: [Field; 4]) -> Field {` | 公开固定四个输入的哈希接口。 |
| 40 | `sponge(input)` | 用 `N = 4` 调用海绵；前三项先触发一次置换，第四项在最终置换前吸收。 |
| 41 | `}` | 结束 `h4`。 |

## `pm_lib/src/domains.nr`

这些数值是公开的协议域分隔常量，用来让相同输入在不同用途下进入不同哈希域。它们不是私钥。当前文件保存的是恢复值，并非从原 Noir `file_map` 直接导出的文件；来源证据应与恢复流程一并核对，不能仅凭文件路径推断出处。

| 原行号 | 原代码 | 中文解释 |
|---:|---|---|
| 1 | `// PROTOCOL: keccak256("pm:<NAME>:v1") reduced modulo the BN254 scalar field.` | 说明生成规则：对用途字符串做 Keccak-256，再约减到 BN254 标量域。 |
| 2 | `// @orig index-CVtw0LZh.js:18525-18529 FS/IS` | 记录恢复时使用的原前端 bundle 证据位置；这不表示该文件来自 Noir `file_map`。 |
| 3 | `pub global D_SPEND: Field = 7193331773697701954242806102593308786482346320275326504853940774892326928622;` | spending-key 派生的域常量。 |
| 4 | `pub global D_NKC: Field = 1692775097038287446316870430920928102839113150648459893794187606663917936697;` | nullifier-key commitment 的域常量。 |
| 5 | `pub global D_OWNER: Field = 20032609920015481401977960501462862097722493379304195089912553214360709785055;` | owner 派生的域常量。 |
| 6 | `pub global D_INNER: Field = 13666839807711405680536256189571314505958992886747803000910165304691830627233;` | inner commitment 的域常量。 |
| 7 | `pub global D_NOTE: Field = 21729403215316104417005496958903634762270750521130681084380469169942409875285;` | 完整票据 commitment 的域常量。 |
| 8 | `pub global D_LOC: Field = 1301980194940446690880367533139958509320877115465620452822595606424801692540;` | 票据位置派生的域常量。 |
| 9 | `pub global D_NF: Field = 14043692604622248171267122940719384144956859722580160290948099227357681523957;` | nullifier 的域常量。 |
| 10 | `pub global D_TAG: Field = 17242398531724950788924618192691874156127979294698361890048305229753051580292;` | 真实 hold tag 的域常量。 |
| 11 | `pub global D_TAG_DUMMY: Field = 7840733290030005043956187298822051482238057504334393064148342572122697419325;` | dummy tag 的独立域常量。 |

## 审阅时的核对清单

- 先用 `python3 verify.py` 确认阅读包未偏离清单，再对照表中的原行号看源码。
- 把电路内约束和电路外检查分开：Pool 的全局 nullifier 状态、合约对 `ext_hash` 的重算、公共输入顺序都不由源码中的单个 `assert` 自动覆盖。
- 不把 hold 证明描述成任意时刻的当前可花余额证明；它没有独立检查已用 nullifier。
- 不把编译成功等同于旧产物等价。还需比较 ABI、ACIR、证明和 verifier 接受结果。
- 不把 `domains.nr` 说成从原 `file_map` 直接导出，也不把公开域常量当成秘密材料。
