# The mathematics of the two-tangent ellipse solver

This document derives, from scratch, the mathematics the solver in `src/ellipse.js`
is built on. The problem it answers is:

> Given two points $P_0, P_1$ in the plane and a tangent direction at each,
> find the ellipse(s) passing through both points with those tangents.

The derivation is self-contained. It assumes only comfort with basic algebra,
$2\times 2$ matrices, and eigenvalues. Nothing here is novel — the family is a
classical *bitangent pencil of conics*, and the conic-to-ellipse conversion is
standard analytic geometry — but collecting the whole pipeline in one place, with
the exact algebra the code uses, makes a nice read.

Coordinates are whatever the caller supplies. The tool defaults to a screen-style
$y$-down frame (so the reported rotation drops straight into an SVG
`x-axis-rotation`), but none of the mathematics below depends on the orientation.

---

## 1. Why there is a *family*, not an answer

A general conic is the zero set of

```math
Q(x, y) = A x^2 + B xy + C y^2 + D x + E y + F = 0 .
```

Scaling all six coefficients by a nonzero constant gives the same curve, so a
conic has $6 - 1 = 5$ degrees of freedom. An ellipse specifically is pinned down
by five numbers: its center $(c_x, c_y)$, its two semi-axes $r_x, r_y$, and its
orientation $\theta$.

Each input supplies constraints:

- **Passing through a given point** is one linear condition on the coefficients
  ($Q(P) = 0$).
- **Being tangent to a given line at a given point on it** is *two* conditions:
  pass through the point (1) and match the tangent direction there (1).

Two prescribed contacts therefore impose $2 + 2 = 4$ conditions. That leaves
$5 - 4 = 1$ degree of freedom: a **one-parameter family** of conics meets the
input, and picking a single ellipse requires a *fifth constraint*. Everything the
tool's "modes" do is supply that fifth constraint in different ways.

---

## 2. Lines as linear forms

Write a line through point $p$ with unit direction $d = (d_x, d_y)$ as a linear
form whose gradient is the line's unit normal $n = (-d_y, d_x)$:

```math
L(x, y) = n \cdot \big((x, y) - p\big) = a x + b y + c,
\qquad (a, b) = (-d_y,\ d_x),\quad c = -(a\,p_x + b\,p_y).
```

Two facts are used constantly:

1. $L(p) = 0$ for any point $p$ on the line, and $L$ is **affine**: for points
   $r = p + s\,v$, $L(r) = L(p) + s\,(n \cdot v)$.
2. $\nabla L = (a, b) = n$, the constant unit normal. In particular
   $n \cdot d = 0$: moving *along* the line does not change $L$.

This is `lineThrough` in the code. The gradient being exactly $n$ is what makes
the tangency proof in the next section a one-liner.

We name three lines:

- $L_0$ — the tangent line at $P_0$ (through $P_0$, direction $d_0$),
- $L_1$ — the tangent line at $P_1$ (through $P_1$, direction $d_1$),
- $M$ — the **chord line** through $P_0$ and $P_1$.

The product of two linear forms $L = a x + b y + c$ and $L' = a' x + b' y + c'$ is
a conic; multiplying out $L \cdot L'$ and collecting terms gives its coefficients
(this is `mulForms`):

```math
\begin{aligned}
A &= a a', & B &= a b' + b a', & C &= b b',\\
D &= a c' + c a', & E &= b c' + c b', & F &= c c'.
\end{aligned}
```

---

## 3. The bitangent pencil

Here is the whole family in one line. With $L_0, L_1, M$ as above, define for each
real $t$

```math
\boxed{\, Q_t(x, y) = L_0(x, y)\,L_1(x, y) + t\, M(x, y)^2 \,}
```

Every conic tangent to $L_0$ at $P_0$ and to $L_1$ at $P_1$ is some $Q_t$ (plus the
degenerate limit $M^2$ itself, "at $t = \infty$"). This is `coeffsAt(t)`: because
each coefficient of $Q_t$ is affine in $t$, it is just $\text{(coeffs of } L_0 L_1) + t \cdot(\text{coeffs of } M^2)$, stored as `P` and `S`.

### 3.1 Each $Q_t$ has the required contact

**Incidence.** $M(P_0) = 0$ (the chord passes through $P_0$) and $L_0(P_0) = 0$,
so

```math
Q_t(P_0) = \underbrace{L_0(P_0)}_{0}\,L_1(P_0) + t\,\underbrace{M(P_0)^2}_{0} = 0 .
```

The same holds at $P_1$. So every member passes through both points.

**Tangency.** Differentiate using the product rule:

```math
\nabla Q_t = L_1\,\nabla L_0 + L_0\,\nabla L_1 + 2t\,M\,\nabla M .
```

Evaluate at $P_0$, where $L_0(P_0) = 0$ and $M(P_0) = 0$:

```math
\nabla Q_t(P_0) = L_1(P_0)\,\nabla L_0 = L_1(P_0)\, n_0 .
```

Provided $P_0$ is not also on $L_1$ (guaranteed once the input checks pass — see
§7), $L_1(P_0) \neq 0$, so the gradient of $Q_t$ at $P_0$ is a nonzero multiple of
$n_0$, the normal to $L_0$. A curve's tangent line is perpendicular to its
gradient, so the tangent to $Q_t$ at $P_0$ is exactly the line with normal
$n_0$ — that is, $L_0$. Identically, $Q_t$ is tangent to $L_1$ at $P_1$. $\qquad\blacksquare$

### 3.2 These are *all* of them

The conics form a 5-dimensional projective space $\mathbb{P}^5$ (the six
coefficients up to scale). The four contact conditions of §1 are linear in the
coefficients, cutting the solution set down to a projective *line* — a **pencil**,
one projective parameter. Since $t \mapsto Q_t$ is affine in $t$, its image is a
line in $\mathbb{P}^5$; it lies inside that codimension-4 solution set (§3.1) and
therefore *is* the pencil. The single point the affine parameter misses ($t \to \infty$) is the doubled chord $M^2 = 0$, the degenerate member where the ellipse
has collapsed onto the segment $P_0P_1$.

The two spanning members are both degenerate conics:

- $t = 0$: $L_0 L_1 = 0$, the **pair of tangent lines**;
- $t = \infty$: $M^2 = 0$, the **doubled chord**.

Between these two degenerate extremes live the honest ellipses (and, past a
boundary, hyperbolas — §5).

### 3.3 The member through a third point

Because $t$ appears linearly and $Q_t(r) = L_0(r) L_1(r) + t\,M(r)^2$, requiring
the curve to pass through any third point $r$ (with $M(r) \neq 0$, i.e. $r$ off
the chord line) fixes $t$ immediately:

```math
Q_t(r) = 0 \Longrightarrow
\boxed{\, t = -\dfrac{L_0(r)\,L_1(r)}{M(r)^2} \,}
```

This is `tThroughPoint`, and it is the workhorse behind both the "third point"
mode and the geometric apex parameterization of §5.

---

## 4. From conic coefficients to ellipse parameters

Given the coefficients of a member $Q_t$, we need its center, axes, orientation,
and a real/degenerate check. Write the quadratic part as the symmetric matrix

```math
\mathbf{M}_2 = \begin{pmatrix} A & B/2 \\ B/2 & C \end{pmatrix},
\qquad
Q(p) = p^\top \mathbf{M}_2\, p + \mathbf{b}^\top p + F,
\quad \mathbf{b} = (D, E).
```

### 4.1 Classification

The determinant $\det \mathbf{M}_2 = AC - B^2/4 = -\tfrac14(B^2 - 4AC)$ controls
the type. The quantity $B^2 - 4AC$ is the familiar **discriminant** (`conicDiscriminant`):

```math
B^2 - 4AC \quad \begin{cases} < 0 & \text{ellipse (}\mathbf{M}_2\text{ definite)}\\ = 0 & \text{parabola}\\ > 0 & \text{hyperbola.}\end{cases}
```

`conicToEllipse` returns `null` unless the discriminant is negative *and* the
resulting radii come out real and positive (§4.3); `classifyConic` uses the same
discriminant, with tolerances, to label the degenerate cases.

### 4.2 The center

The center is the stationary point, $\nabla Q = 0$:

```math
\begin{pmatrix} 2A & B \\ B & 2C \end{pmatrix}
\begin{pmatrix} c_x \\ c_y \end{pmatrix}
= \begin{pmatrix} -D \\ -E \end{pmatrix}.
```

Inverting the $2\times 2$ system (with $\det = 4AC - B^2$) gives `centerAndConstant`:

```math
c_x = \frac{-2CD + BE}{4AC - B^2},
\qquad
c_y = \frac{-2AE + BD}{4AC - B^2}.
```

### 4.3 Reducing to center-relative form

Translate the origin to the center, $p = c + q$. The linear term vanishes by
construction, leaving

```math
Q(c + q) = q^\top \mathbf{M}_2\, q + F',
\qquad F' = Q(c).
```

A short computation gives $F'$ without re-substituting. Since $\mathbf{M}_2 c = -\tfrac12 \mathbf{b}$ (the center equation),

```math
Q(c) = c^\top \mathbf{M}_2 c + \mathbf{b}^\top c + F
     = -\tfrac12 \mathbf{b}^\top c + \mathbf{b}^\top c + F
     = F + \tfrac12(D c_x + E c_y) = F'.
```

That is exactly the `Fp` in `centerAndConstant`. The ellipse is now the level set

```math
q^\top \mathbf{M}_2\, q = -F'.
```

### 4.4 Axes, radii, and orientation

Diagonalize the symmetric matrix $\mathbf{M}_2$. Its eigenvalues are

```math
\lambda_\pm = \frac{A + C \pm R}{2},
\qquad R = \sqrt{(A - C)^2 + B^2} = \mathrm{hypot}(A - C,\, B),
```

matching `lHigh`/`lLow` with `R = Math.hypot(A - C, B)`. In the eigenbasis
$(\xi, \eta)$ the equation becomes $\lambda_- \xi^2 + \lambda_+ \eta^2 = -F'$.
Setting one coordinate to zero gives the semi-axis along the other eigenvector:

```math
r_x^2 = \frac{-F'}{\lambda_{\min}},
\qquad
r_y^2 = \frac{-F'}{\lambda_{\max}} .
```

The **smaller** eigenvalue yields the **larger** radius. Both must be positive for
a real ellipse; if either is not, `conicToEllipse` rejects the conic (it is
imaginary or degenerate).

The orientation is the eigenvector angle of $\mathbf{M}_2$. For a symmetric
$\left(\begin{smallmatrix} A & B/2 \\ B/2 & C\end{smallmatrix}\right)$ the principal angle
satisfies $\tan 2\varphi = \dfrac{B}{A - C}$, so the axis of $\lambda_{\max}$ points
at $\varphi = \tfrac12 \mathrm{atan2}(B,\, A - C)$. The major axis ($r_x$)
is perpendicular to it, hence

```math
\theta = \tfrac12 \mathrm{atan2}(B,\, A - C) + \tfrac{\pi}{2}.
```

To keep the invariant "$r_x$ is the semi-major radius and $\theta$ points along
it," the code compares $r_x^2$ and $r_y^2$ directly and, if they came out
swapped (a sign convention can flip which eigenvalue is "larger"), swaps the
radii and rotates $\theta$ by $\tfrac{\pi}{2}$. Finally $\theta$ is folded into
$(-\tfrac{\pi}{2}, \tfrac{\pi}{2}]$ by `wrapHalfAngle`, since an ellipse's
orientation is only defined modulo $\pi$. The eccentricity is the usual

```math
e = \sqrt{1 - \frac{r_y^2}{r_x^2}}.
```

---

## 5. A geometric handle on the family: the apex parameter

The raw parameter $t$ is awkward: the ellipse range is some sub-interval of
$\mathbb{R}$ with no obvious endpoints, and it is unbounded. The tool instead
sweeps the family with a geometric parameter $a$, defined so that the ellipses
occupy exactly $a \in (0, \tfrac12)$.

### 5.1 Intersecting tangents

Let $V$ be the intersection of the two tangent lines and $\mathrm{mid} = \tfrac12(P_0 + P_1)$ the chord midpoint. Define the *apex point*

```math
r(a) = \mathrm{mid} + a\,(V - \mathrm{mid}), \qquad a \in (0, 1),
```

and take the member of the family that passes through it,
$t(a) = -\,L_0(r)L_1(r)/M(r)^2$ from §3.3. This has a clean closed form. Using
affinity of the linear forms and the facts $M(\mathrm{mid}) = 0$ (the midpoint is
on the chord) and $L_0(V) = L_1(V) = 0$ ($V$ is on both tangent lines):

```math
\begin{aligned}
M(r) &= (1 - a)\,M(\mathrm{mid}) + a\,M(V) = a\,M(V),\\
L_0(r) &= (1 - a)\,L_0(\mathrm{mid}) + a\,L_0(V) = (1 - a)\,L_0(\mathrm{mid}),\\
L_1(r) &= (1 - a)\,L_1(\mathrm{mid}).
\end{aligned}
```

Writing $k_0 = L_0(\mathrm{mid})\,L_1(\mathrm{mid})$ and $m_V = M(V)$,

```math
\boxed{\, t(a) = -\,\frac{(1 - a)^2\,k_0}{a^2\,m_V^2}
              = -\,k_0\left(\frac{1 - a}{a}\right)^2 \frac{1}{m_V^2}. \,}
```

This is `tFromApex` (with $r = (1-a)/a$), and its cached constants are `_k0` and
`_mV2`. Inverting it is `apexFromT`; it returns `null` for the $t$-values whose
apex would be imaginary (the hyperbola side of the family).

### 5.2 Why $a = \tfrac12$ is the parabola

Recall $\det \mathbf{M}_2 = AC - B^2/4$ decides the type ($>0$ ellipse, $=0$
parabola). A remarkable simplification: as a function of $t$, this determinant is
only **linear**, not quadratic. The reason is that the doubled-chord conic $M^2$
has a *rank-one* quadratic part. If $M = a_M x + b_M y + c_M$ with unit normal
($a_M^2 + b_M^2 = 1$), then $M^2$ has quadratic-part matrix
$\left(\begin{smallmatrix} a_M^2 & a_M b_M \\ a_M b_M & b_M^2\end{smallmatrix}\right)$, whose
determinant is $a_M^2 b_M^2 - (a_M b_M)^2 = 0$. Expanding
$\det \mathbf{M}_2(t)$ for $Q_t = L_0L_1 + tM^2$, the $t^2$ term is precisely that
determinant, so it vanishes:

```math
\det \mathbf{M}_2(t) = q_0 + q_1\, t,
\qquad
\begin{aligned}
q_0 &= A_P C_P - \tfrac14 B_P^2,\\
q_1 &= A_P C_S + A_S C_P - \tfrac12 B_P B_S,
\end{aligned}
```

where subscripts $P, S$ denote the coefficients of $L_0L_1$ and $M^2$. Being
linear, it has a **single** finite root — one parabola in the pencil (the other
"type change" is the degenerate $M^2$ at infinity) — at
$t_p = -q_0/q_1$.

Now evaluate the apex map at $a = \tfrac12$, where $(1-a)/a = 1$:

```math
t\!\left(\tfrac12\right) = -\frac{k_0}{m_V^2}.
```

One can check (and the implementation's constants make it an identity)
that $-k_0/m_V^2 = -q_0/q_1 = t_p$. So the apex parameterization is calibrated so
that **$a = \tfrac12$ lands exactly on the parabola.** As $a$ decreases from
$\tfrac12$ toward $0$, $(1-a)/a \to \infty$ and $t \to \infty$: the member tends
to the doubled chord, i.e. the ellipse flattens onto the segment $P_0P_1$. So the
ellipses are precisely $a \in (0, \tfrac12)$: from a sliver hugging the chord
($a \to 0$) to the parabola boundary ($a \to \tfrac12$). Beyond it, $a \in (\tfrac12, 1)$ gives hyperbolas.

### 5.3 Parallel tangents

If the tangents are parallel there is no intersection point $V$, and the chord
$P_0P_1$ is a *diameter* of every member. Parameterize instead by the half-length
$b$ of the conjugate semi-diameter along the common tangent direction $d_0$:

```math
r(b) = \mathrm{mid} + b\,d_0.
```

Here $M(\mathrm{mid}) = 0$ and, since both tangent normals are perpendicular to
$d_0$, $L_0(r) = L_0(\mathrm{mid})$ and $L_1(r) = L_1(\mathrm{mid})$ (moving along
$d_0$ does not change them). With $m_d = M(\mathrm{mid} + d_0) = n_M \cdot d_0$,

```math
M(r) = b\,m_d,
\qquad
t = -\frac{L_0(\mathrm{mid})L_1(\mathrm{mid})}{(b\,m_d)^2}
  = -\frac{k_0}{b^2\, m_d^2},
```

which is `tFromApex` in the `parallel` branch (`_md2 = m_d^2`). To keep a single
$a \in (0, \tfrac12)$ slider across both cases, $b$ is tied to $a$ by the
increasing bijection

```math
b = \mathrm{halfChord}\cdot \frac{a}{\tfrac12 - a},
```

so $a \to 0$ gives $b \to 0$ (collapse onto the chord) and $a \to \tfrac12$ gives
$b \to \infty$ (the parabola, whose conjugate diameter is infinite) — matching the
intersecting case exactly.

### 5.4 Search-friendly reparameterization

For the numerical modes (§6) the slider is pushed through a logistic map so that
resolution is spread evenly across the whole open interval rather than bunching in
the middle:

```math
a(u) = \frac{1/2}{1 + e^{-u}}, \qquad u \in \mathbb{R},
```

(`aFromU` / `uFromA`). Both endpoints $a \to 0$ and $a \to \tfrac12$ push $u \to \mp\infty$, so a bounded scan in $u$ still probes arbitrarily close to the
collapse and the parabola.

---

## 6. The fifth constraint: the five modes

Each mode picks one member (or a few) by adding a fifth condition.

### 6.1 Third point — direct

Covered in §3.3: $t = -L_0(r)L_1(r)/M(r)^2$. Exactly one member.

### 6.2 Apex — direct

Covered in §5: evaluate $t(a)$ for the requested $a$. This is what the slider
drives, and it can reach every ellipse in the family.

### 6.3 Roundest — a 1-D minimization

"Roundest" is the member minimizing the axis ratio $r_x/r_y \ge 1$ (equal to $1$
exactly when the family contains a circle). The ratio is a smooth function of the
apex parameter on $(0, \tfrac12)$, blowing up at both ends (a sliver near $a \to 0$, an infinitely elongated near-parabola near $a \to \tfrac12$), so it has an
interior minimum. The code finds it with a coarse scan in $u$ followed by a
**golden-section search** — the standard bracketing minimizer for a unimodal
function that needs no derivatives. Because the reduction from coefficients to
$r_x/r_y$ involves a square root of eigenvalues, there is no useful closed form;
this mode is numerical (accurate to $\sim 8$ significant figures).

### 6.4 Rotation — linear in $t$

Requiring the axes to sit at a given angle $\theta$ is asking for the cross-term
to vanish in the $\theta$-rotated frame. Rotating a conic by $\theta$ sends its
$xy$ coefficient to

```math
B'(\theta) = B\cos 2\theta - (A - C)\sin 2\theta .
```

Setting $B' = 0$ aligns the axes with the $\theta$ frame. Define $g(A, B, C) = B\cos 2\theta - (A - C)\sin 2\theta$. Because $A, B, C$ are affine in $t$, so is
$g$:

```math
g(Q_t) = g_P + t\, g_S,
\qquad
t = -\frac{g_P}{g_S},
```

where $g_P = g(L_0L_1)$ and $g_S = g(M^2)$. This is `withRotation`: exactly one
candidate $t$ (it may turn out to be a hyperbola/parabola, which is then
rejected). Note $B'(\theta) = 0$ holds for the axes at $\theta$ *or* $\theta + 90°$, which is why the rotation solve is $90°$-periodic — the tool folds the
target into $[0°, 90°)$.

### 6.5 Aspect ratio — quadratic in $t$

Let the ratio be $k = r_{\text{major}}/r_{\text{minor}} \ge 1$. From §4.4, $r^2 \propto 1/\lambda$, so $k^2 = \lambda_{\max}/\lambda_{\min}$. Using the trace
$\tau = \lambda_{\max} + \lambda_{\min} = A + C$ and determinant
$\delta = \lambda_{\max}\lambda_{\min} = AC - B^2/4$,

```math
\frac{\tau^2}{\delta}
= \frac{(\lambda_{\max} + \lambda_{\min})^2}{\lambda_{\max}\lambda_{\min}}
= k^2 + 2 + \frac{1}{k^2}
= \frac{(k^2 + 1)^2}{k^2} .
```

So the constraint is $k^2\,(A + C)^2 = (k^2+1)^2\,(AC - B^2/4)$. Substituting the
affine $A + C = s_0 + t s_1$ and the **linear** $AC - B^2/4 = q_0 + t q_1$ (linear
because $\det \mathbf{M}_2(t)$ has no $t^2$ term — §5.2!), and writing $w = (k^2+1)^2$, gives a genuine quadratic in $t$:

```math
\underbrace{k^2 s_1^2}_{\text{qa}}\, t^2
+ \underbrace{\big(2 k^2 s_0 s_1 - w\, q_1\big)}_{\text{qb}}\, t
+ \underbrace{\big(k^2 s_0^2 - w\, q_0\big)}_{\text{qc}} = 0 .
```

These are exactly `qa`, `qb`, `qc` in `withAspectRatio`. Hence a given ratio can
match **0, 1, or 2** ellipses — the source of the "Next solution" toggle. (Had
$M^2$ not been rank-one, the determinant would be quadratic and this condition
quartic; the degeneracy of the doubled chord is what keeps it quadratic.) The
quadratic is solved with a cancellation-avoiding formula, and a discriminant that
is negative only within rounding of zero is treated as a grazing double root —
which is what happens when the requested ratio equals the family's minimum (the
"roundest" value carried into this mode).

### 6.6 Radius $r_x$ or $r_y$ — numerical with guards

Fixing a specific semi-axis length has no clean low-degree form (again the square
root), so it is solved numerically: sample $f(u) = r_\bullet(u) - \text{value}$
across the logistic sweep, bracket sign changes, and bisect. Two safeguards
matter:

- Near the parabola boundary the radii diverge, and near the chord-collapse end
  ($r_y \to 0$) the geometry is ill-conditioned, so a bracket can straddle a pole
  or numerical noise rather than a true crossing. A candidate is **accepted only
  if it actually hits the target** to a relative tolerance, discarding artifacts.
- For $r_x$ there is a hard lower bound. The chord $P_0P_1$ is itself a chord of
  the ellipse, and no chord can exceed the major axis $2 r_x$. Hence
  $\lvert P_0P_1 \rvert \le 2 r_x$, i.e.

```math
r_x \ge \tfrac12\lvert P_0 P_1\rvert = \mathrm{halfChord}.
```

Requests below this are rejected up front with an explanatory error.

---

## 7. Degeneracies and existence

The construction assumes a few genericity conditions, which the constructor
checks and turns into clear errors:

- **Coincident points** ($P_0 = P_1$): there is no chord line $M$; rejected.
- **A tangent along the chord** ($d_0 \parallel P_0P_1$ or $d_1 \parallel P_0P_1$): then $P_0$ lies on $L_1$ (or $P_1$ on $L_0$), the factor $L_1(P_0)$ in
  the tangency proof of §3.1 vanishes, and no ellipse can be tangent there and
  still reach the other point; rejected.
- **A third point on the chord line** ($M(r) = 0$): the "through a point" formula
  divides by $M(r)^2$; rejected.

Beyond these, a *particular* requested value (a rotation angle, an aspect ratio, a
radius) may simply have no ellipse in the family — the corresponding member is a
parabola or hyperbola. Those candidates are computed honestly and then filtered
out by the real-ellipse test of §4.4, so a mode can legitimately return zero
solutions.

---

## 8. Summary of the pipeline

1. Build the three linear forms $L_0, L_1, M$ (§2) and the pencil $Q_t = L_0 L_1 + t M^2$ (§3).
2. A fifth constraint selects one or more values of $t$: directly (third point,
   apex), by a linear solve (rotation), a quadratic solve (aspect ratio), or a
   1-D numerical search (roundest, radius) — §5–6.
3. For each selected $t$, convert the conic coefficients to center, semi-axes,
   orientation, and eccentricity, rejecting anything that is not a real ellipse
   (§4).

Every exact mode (apex, third point, rotation, aspect ratio) is closed-form; the
two search-based modes (roundest, radius) are numerical to about eight significant
figures. All of it rests on the single, classical observation that conics with
prescribed double contact form the pencil $L_0 L_1 + t M^2$.
