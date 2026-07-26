# Maxwell's Equations: A Textbook Chapter

Maxwell's equations are the foundation of classical electromagnetism. They
describe how electric charge and electric current produce fields, how changing
electric and magnetic fields create one another, and how electromagnetic energy
propagates through space.

Their scope is remarkably broad. Electrostatics, magnets, circuits, antennas,
radio, optics, microwaves, X-rays, electric motors, generators, transformers,
and much of modern communication technology all follow from the same four
equations.

This chapter develops the equations from physical intuition to practical use.
It assumes elementary calculus and introduces the necessary vector calculus as
it is needed.

## Learning objectives

After studying this chapter, you should be able to:

1. State Maxwell's equations in differential and integral form.
2. Explain the physical meaning of divergence, curl, flux, and circulation.
3. Use symmetry to calculate electric and magnetic fields.
4. Explain electromagnetic induction and Maxwell's displacement current.
5. Derive charge conservation and the electromagnetic wave equation.
6. Apply electromagnetic boundary conditions at material interfaces.
7. Describe electromagnetic energy flow using the Poynting vector.
8. Connect electrostatics, magnetostatics, circuits, optics, and waves to one
   unified theory.

## 1. Fields, sources, and notation

An electromagnetic field assigns physical quantities to every point in space
and time. The electric field is \(\mathbf{E}(\mathbf{r},t)\), and the magnetic
field is \(\mathbf{B}(\mathbf{r},t)\). Their sources are the charge density
\(\rho(\mathbf{r},t)\) and current density \(\mathbf{J}(\mathbf{r},t)\).

The Lorentz force law tells us how fields act on a particle of charge \(q\)
and velocity \(\mathbf{v}\):

\[
\mathbf{F}=q\left(\mathbf{E}+\mathbf{v}\times\mathbf{B}\right).
\]

Maxwell's equations explain how the fields are created and evolve; the Lorentz
force law explains how those fields act on matter. Together, they form the core
of classical electrodynamics.

### 1.1 Symbols used throughout the chapter

- \(\mathbf{E}\): electric field, measured in volts per meter
- \(\mathbf{B}\): magnetic flux density, measured in tesla
- \(\rho\): volume charge density, measured in coulombs per cubic meter
- \(\mathbf{J}\): current density, measured in amperes per square meter
- \(\varepsilon_0\): vacuum permittivity
- \(\mu_0\): vacuum permeability
- \(\mathbf{D}\): electric displacement field
- \(\mathbf{H}\): magnetic field intensity
- \(d\mathbf{a}=\hat{\mathbf{n}}\,da\): oriented area element
- \(d\boldsymbol{\ell}\): directed line element
- \(Q_{\mathrm{enc}}\): charge enclosed by a closed surface
- \(I_{\mathrm{enc}}\): conduction current crossing an open surface

Useful vacuum constants are

\[
\begin{aligned}
\varepsilon_0 &\approx 8.854\times10^{-12}\ \mathrm{F\,m^{-1}},\\
\mu_0 &\approx 1.257\times10^{-6}\ \mathrm{H\,m^{-1}},\\
c&=\frac{1}{\sqrt{\mu_0\varepsilon_0}}
=2.99792458\times10^8\ \mathrm{m\,s^{-1}}.
\end{aligned}
\]

### 1.2 The four equations at a glance

In vacuum, with charge and current present, Maxwell's equations are

\[
\boxed{
\begin{aligned}
\nabla\cdot\mathbf{E}&=\frac{\rho}{\varepsilon_0},
&&\text{Gauss's law for electricity},\\
\nabla\cdot\mathbf{B}&=0,
&&\text{Gauss's law for magnetism},\\
\nabla\times\mathbf{E}&=-\frac{\partial\mathbf{B}}{\partial t},
&&\text{Faraday's law},\\
\nabla\times\mathbf{B}&=\mu_0\mathbf{J}
+\mu_0\varepsilon_0\frac{\partial\mathbf{E}}{\partial t},
&&\text{Ampere--Maxwell law}.
\end{aligned}}
\]

The first two equations constrain the spatial structure of the fields. The last
two describe how fields circulate and how time-varying electric and magnetic
fields are coupled.

## 2. Mathematical language: divergence, curl, flux, and circulation

Maxwell's equations are compact because vector calculus packages geometric
information into a few operators.

### 2.1 Divergence

The divergence of a vector field measures its local outward flow per unit
volume:

\[
\nabla\cdot\mathbf{E}
=\frac{\partial E_x}{\partial x}
+\frac{\partial E_y}{\partial y}
+\frac{\partial E_z}{\partial z}.
\]

A positive divergence means that a small region behaves like a source. A
negative divergence means that it behaves like a sink. Zero divergence does not
mean that the field itself is zero; it means that the net flow out of a tiny
closed volume is zero.

The divergence theorem converts a local statement into a statement about a
finite volume \(V\) bounded by the closed surface \(\partial V\):

\[
\iiint_V \nabla\cdot\mathbf{E}\,dV
=\oiint_{\partial V}\mathbf{E}\cdot d\mathbf{a}.
\]

The surface integral is the electric flux through the closed surface.

### 2.2 Curl

The curl measures the local circulation or rotational tendency of a vector
field:

\[
\nabla\times\mathbf{E}
=\begin{vmatrix}
\hat{\mathbf{x}}&\hat{\mathbf{y}}&\hat{\mathbf{z}}\\
\partial/\partial x&\partial/\partial y&\partial/\partial z\\
E_x&E_y&E_z
\end{vmatrix}.
\]

Stokes' theorem connects local curl to circulation around a finite closed curve
\(C=\partial S\):

\[
\iint_S(\nabla\times\mathbf{E})\cdot d\mathbf{a}
=\oint_C\mathbf{E}\cdot d\boldsymbol{\ell}.
\]

The orientation of \(C\) and the normal to \(S\) are related by the
right-hand rule.

### 2.3 Why both forms matter

The differential form describes what happens at each point and is ideal for
deriving wave equations or solving boundary-value problems. The integral form
relates fields to finite surfaces and loops and is often the fastest route when
symmetry is present.

## 3. Gauss's law for electricity

### 3.1 Differential and integral forms

\[
\boxed{\nabla\cdot\mathbf{E}=\frac{\rho}{\varepsilon_0}}
\]

Integrating over a volume and applying the divergence theorem gives

\[
\boxed{
\oiint_{\partial V}\mathbf{E}\cdot d\mathbf{a}
=\frac{Q_{\mathrm{enc}}}{\varepsilon_0},
\qquad
Q_{\mathrm{enc}}=\iiint_V\rho\,dV.
}
\]

Electric charge is the source or sink of electric flux. Positive enclosed
charge produces net outward flux, while negative enclosed charge produces net
inward flux. Charges outside the surface can contribute to the field at the
surface, but their total contribution to the net flux is zero.

### 3.2 Example: field of a point charge

Place a charge \(q\) at the origin. Spherical symmetry requires the field to
be radial and to have the same magnitude everywhere on a sphere of radius
\(r\):

\[
\mathbf{E}(r)=E(r)\hat{\mathbf{r}}.
\]

Choose that sphere as the Gaussian surface. Since
\(\mathbf{E}\parallel d\mathbf{a}\),

\[
\begin{aligned}
\oiint\mathbf{E}\cdot d\mathbf{a}
&=E(r)\oiint da\\
&=E(r)4\pi r^2
=\frac{q}{\varepsilon_0}.
\end{aligned}
\]

Therefore,

\[
\boxed{
\mathbf{E}(r)=\frac{q}{4\pi\varepsilon_0r^2}\hat{\mathbf{r}}.
}
\]

This is Coulomb's law. Gauss's law does not merely agree with Coulomb's law; in
electrostatics, together with \(\nabla\times\mathbf{E}=0\), it contains the
same physical information.

### 3.3 Example: uniformly charged solid sphere

Consider a sphere of radius \(R\), total charge \(Q\), and uniform charge
density

\[
\rho=\frac{Q}{\frac{4}{3}\pi R^3}.
\]

For \(r<R\), the enclosed charge is

\[
Q_{\mathrm{enc}}(r)=\rho\frac{4}{3}\pi r^3
=Q\frac{r^3}{R^3}.
\]

Gauss's law gives

\[
\boxed{
\mathbf{E}(r)=
\begin{cases}
\displaystyle \frac{Qr}{4\pi\varepsilon_0R^3}\hat{\mathbf{r}},&r<R,\\[6pt]
\displaystyle \frac{Q}{4\pi\varepsilon_0r^2}\hat{\mathbf{r}},&r\ge R.
\end{cases}}
\]

The field grows linearly from zero inside the sphere and falls as \(1/r^2\)
outside it. The two expressions agree at \(r=R\), so the field is continuous
when no surface charge sheet is present.

### 3.4 When Gauss's law is useful for calculation

Gauss's law is always true, but it is easy to solve for the field only when
symmetry makes the field magnitude constant on a suitable surface. The most
important useful symmetries are:

- spherical symmetry, using a sphere;
- cylindrical symmetry, using a coaxial cylinder;
- planar symmetry, using a thin pillbox.

Without sufficient symmetry, Gauss's law still constrains the field but usually
does not determine it by itself.

## 4. Gauss's law for magnetism

### 4.1 Differential and integral forms

\[
\boxed{\nabla\cdot\mathbf{B}=0}
\]

Equivalently,

\[
\boxed{\oiint_{\partial V}\mathbf{B}\cdot d\mathbf{a}=0.}
\]

Every closed surface has zero net magnetic flux. Magnetic field lines do not
begin or end; they form closed loops or extend indefinitely. A bar magnet has a
north and south pole, but cutting it in half produces two smaller dipoles, not
isolated magnetic charges.

### 4.2 Consequence: the vector potential

A divergence-free field can be written as the curl of another vector field.
Therefore, at least locally,

\[
\boxed{\mathbf{B}=\nabla\times\mathbf{A},}
\]

where \(\mathbf{A}\) is the magnetic vector potential. This automatically
satisfies Gauss's law for magnetism because the divergence of any curl is zero:

\[
\nabla\cdot(\nabla\times\mathbf{A})=0.
\]

### 4.3 Magnetic flux continuity

Apply the integral law to a very thin pillbox that crosses an interface. In the
limit of zero thickness,

\[
\hat{\mathbf{n}}\cdot(\mathbf{B}_2-\mathbf{B}_1)=0.
\]

The normal component of \(\mathbf{B}\) is continuous across every ordinary
interface. Magnetic field lines cannot terminate at the boundary.

## 5. Faraday's law of induction

### 5.1 Differential and integral forms

\[
\boxed{
\nabla\times\mathbf{E}=-\frac{\partial\mathbf{B}}{\partial t}}
\]

For a fixed loop \(C\) bounding a fixed surface \(S\),

\[
\boxed{
\oint_C\mathbf{E}\cdot d\boldsymbol{\ell}
=-\frac{d}{dt}\iint_S\mathbf{B}\cdot d\mathbf{a}
=-\frac{d\Phi_B}{dt}.}
\]

The circulation of the induced electric field is the electromotive force,

\[
\mathcal{E}=\oint_C\mathbf{E}\cdot d\boldsymbol{\ell}.
\]

Unlike an electrostatic field, an induced electric field generally has nonzero
curl and cannot be described globally as the gradient of a single electrostatic
potential.

### 5.2 Lenz's law and the minus sign

The minus sign states Lenz's law: the induced effect opposes the change in
magnetic flux that produces it. This is required by energy conservation. If the
induced current reinforced the change without an external energy source, the
field and current could grow spontaneously.

The magnetic flux is

\[
\Phi_B=\iint_S\mathbf{B}\cdot d\mathbf{a}.
\]

Flux can change because the magnetic field changes, because the loop changes
area or orientation, or because the loop moves into a region with a different
field. For a moving circuit, the general electromotive force is

\[
\boxed{
\mathcal{E}=\oint_C
\left(\mathbf{E}+\mathbf{v}\times\mathbf{B}\right)
\cdot d\boldsymbol{\ell}.}
\]

The \(\mathbf{v}\times\mathbf{B}\) term is called motional emf.

### 5.3 Example: electric field around a changing solenoid field

Suppose a long solenoid of radius \(R\) produces a spatially uniform but
time-dependent magnetic field \(B(t)\hat{\mathbf{z}}\) inside it, with
negligible magnetic field outside. Cylindrical symmetry implies an azimuthal
electric field \(\mathbf{E}=E_\phi(r)\hat{\boldsymbol{\phi}}\).

For a circular path of radius \(r<R\),

\[
E_\phi(2\pi r)=-\frac{d}{dt}(\pi r^2B),
\]

so

\[
E_\phi(r)=-\frac{r}{2}\frac{dB}{dt},\qquad r<R.
\]

For \(r\ge R\), only the solenoid cross-section contributes to the flux:

\[
E_\phi(2\pi r)=-\frac{d}{dt}(\pi R^2B).
\]

Thus,

\[
\boxed{
\mathbf{E}(r)=
\begin{cases}
\displaystyle -\frac{r}{2}\frac{dB}{dt}\hat{\boldsymbol{\phi}},&r<R,\\[7pt]
\displaystyle -\frac{R^2}{2r}\frac{dB}{dt}\hat{\boldsymbol{\phi}},&r\ge R.
\end{cases}}
\]

The induced electric field exists even outside the region where the magnetic
field is appreciable. It is the change in enclosed flux, not merely the local
value of \(\mathbf{B}\), that controls the circulation.

## 6. The Ampere--Maxwell law

### 6.1 Differential and integral forms

\[
\boxed{
\nabla\times\mathbf{B}
=\mu_0\mathbf{J}
+\mu_0\varepsilon_0\frac{\partial\mathbf{E}}{\partial t}}
\]

Equivalently,

\[
\boxed{
\oint_C\mathbf{B}\cdot d\boldsymbol{\ell}
=\mu_0 I_{\mathrm{enc}}
+\mu_0\varepsilon_0\frac{d\Phi_E}{dt},
\qquad
\Phi_E=\iint_S\mathbf{E}\cdot d\mathbf{a}.}
\]

The first term says that conduction current creates circulating magnetic fields.
The second term is Maxwell's displacement-current contribution: a changing
electric flux also creates a circulating magnetic field.

### 6.2 Magnetostatic example: a long straight wire

For a steady current \(I\) in a long straight wire, cylindrical symmetry
requires

\[
\mathbf{B}=B_\phi(r)\hat{\boldsymbol{\phi}}.
\]

Using a circular Amperian loop,

\[
B_\phi(r)(2\pi r)=\mu_0I,
\]

and therefore

\[
\boxed{
\mathbf{B}(r)=\frac{\mu_0I}{2\pi r}\hat{\boldsymbol{\phi}}.}
\]

The right-hand rule determines the direction of the field around the current.

### 6.3 Why Maxwell had to modify Ampere's law

The original magnetostatic law was

\[
\nabla\times\mathbf{B}=\mu_0\mathbf{J}.
\]

Taking the divergence of both sides gives

\[
0=\mu_0\nabla\cdot\mathbf{J},
\]

because the divergence of a curl is always zero. This would require
\(\nabla\cdot\mathbf{J}=0\) everywhere, which fails when charge accumulates.

Charge conservation instead requires the continuity equation

\[
\boxed{
\nabla\cdot\mathbf{J}+\frac{\partial\rho}{\partial t}=0.}
\]

Taking the divergence of the corrected Ampere--Maxwell law gives

\[
\begin{aligned}
0
&=\mu_0\nabla\cdot\mathbf{J}
+\mu_0\varepsilon_0\frac{\partial}{\partial t}
(\nabla\cdot\mathbf{E})\\
&=\mu_0\nabla\cdot\mathbf{J}
+\mu_0\frac{\partial\rho}{\partial t},
\end{aligned}
\]

which is exactly the continuity equation. Maxwell's additional term makes the
field equations compatible with local charge conservation.

### 6.4 The charging capacitor paradox

Consider a capacitor being charged by a current \(I\). A surface spanning a
loop around the wire can cut through the wire, in which case it encloses
conduction current \(I\). Another surface with the same boundary can bulge
between the capacitor plates, where no charge crosses the gap.

Without displacement current, Ampere's law would give two different magnetic
fields for the same loop. Between ideal parallel plates,

\[
E=\frac{Q}{\varepsilon_0A}.
\]

Therefore,

\[
\varepsilon_0\frac{d\Phi_E}{dt}
=\varepsilon_0\frac{d}{dt}(EA)
=\frac{dQ}{dt}
=I.
\]

The displacement current through the gap exactly equals the conduction current
in the wire, so the result no longer depends on which spanning surface is used.

## 7. Charge conservation

The local continuity equation can be converted to integral form. Integrating
over a fixed volume and applying the divergence theorem gives

\[
\begin{aligned}
\iiint_V\nabla\cdot\mathbf{J}\,dV
+\frac{d}{dt}\iiint_V\rho\,dV&=0,\\
\oiint_{\partial V}\mathbf{J}\cdot d\mathbf{a}
+\frac{dQ_{\mathrm{enc}}}{dt}&=0.
\end{aligned}
\]

Hence,

\[
\boxed{
\frac{dQ_{\mathrm{enc}}}{dt}
=-\oiint_{\partial V}\mathbf{J}\cdot d\mathbf{a}.}
\]

The charge inside a volume decreases exactly at the rate that current flows
out through its boundary. Charge is not created or destroyed by any classical
electromagnetic process.

## 8. Maxwell's equations in matter

Microscopic Maxwell equations treat every charge, including charges bound
inside atoms and molecules, as a source. In macroscopic matter, it is useful to
separate free charge from the response of the material.

### 8.1 Polarization and magnetization

The electric polarization \(\mathbf{P}\) is electric dipole moment per unit
volume. The magnetization \(\mathbf{M}\) is magnetic dipole moment per unit
volume. Define

\[
\boxed{
\mathbf{D}=\varepsilon_0\mathbf{E}+\mathbf{P},
\qquad
\mathbf{H}=\frac{\mathbf{B}}{\mu_0}-\mathbf{M}.}
\]

The macroscopic equations become

\[
\boxed{
\begin{aligned}
\nabla\cdot\mathbf{D}&=\rho_{\mathrm f},\\
\nabla\cdot\mathbf{B}&=0,\\
\nabla\times\mathbf{E}&=-\frac{\partial\mathbf{B}}{\partial t},\\
\nabla\times\mathbf{H}&=\mathbf{J}_{\mathrm f}
+\frac{\partial\mathbf{D}}{\partial t}.
\end{aligned}}
\]

Only free charge and free current appear explicitly. Bound charge and current
are contained in \(\mathbf{P}\) and \(\mathbf{M}\).

### 8.2 Linear, isotropic media

For a simple linear isotropic material,

\[
\mathbf{D}=\varepsilon\mathbf{E},
\qquad
\mathbf{B}=\mu\mathbf{H},
\qquad
\mathbf{J}_{\mathrm f}=\sigma\mathbf{E},
\]

where \(\varepsilon\) is permittivity, \(\mu\) is permeability, and
\(\sigma\) is conductivity. These are constitutive relations, not additional
universal Maxwell equations. Real materials may be nonlinear, anisotropic,
dispersive, lossy, or spatially nonlocal.

## 9. Boundary conditions

Boundary conditions follow directly from the integral equations by shrinking a
pillbox or rectangular loop around an interface. Let
\(\hat{\mathbf{n}}\) point from medium 1 to medium 2, let
\(\sigma_{\mathrm f}\) be free surface charge density, and let
\(\mathbf{K}_{\mathrm f}\) be free surface current density.

The four boundary conditions are

\[
\boxed{
\begin{aligned}
\hat{\mathbf{n}}\cdot(\mathbf{D}_2-\mathbf{D}_1)
&=\sigma_{\mathrm f},\\
\hat{\mathbf{n}}\cdot(\mathbf{B}_2-\mathbf{B}_1)
&=0,\\
\hat{\mathbf{n}}\times(\mathbf{E}_2-\mathbf{E}_1)
&=\mathbf{0},\\
\hat{\mathbf{n}}\times(\mathbf{H}_2-\mathbf{H}_1)
&=\mathbf{K}_{\mathrm f}.
\end{aligned}}
\]

These relations assume that the fields remain finite while the pillbox height
or loop width tends to zero. They say:

- free surface charge produces a jump in normal \(\mathbf{D}\);
- normal \(\mathbf{B}\) is always continuous;
- tangential \(\mathbf{E}\) is continuous across an ordinary interface;
- free surface current produces a jump in tangential \(\mathbf{H}\).

For a perfect conductor in electrostatic equilibrium,

\[
\mathbf{E}_{\mathrm{inside}}=\mathbf{0},
\qquad
\mathbf{E}_{\mathrm{outside},t}=\mathbf{0},
\qquad
D_{\mathrm{outside},n}=\sigma_{\mathrm f}.
\]

Thus the electrostatic field immediately outside a conductor is normal to its
surface.

## 10. Scalar and vector potentials

Because \(\nabla\cdot\mathbf{B}=0\), write

\[
\mathbf{B}=\nabla\times\mathbf{A}.
\]

Substitute this into Faraday's law:

\[
\nabla\times\left(
\mathbf{E}+\frac{\partial\mathbf{A}}{\partial t}
\right)=0.
\]

A curl-free field can be written as the negative gradient of a scalar
potential. Therefore,

\[
\boxed{
\mathbf{E}=-\nabla\phi-\frac{\partial\mathbf{A}}{\partial t},
\qquad
\mathbf{B}=\nabla\times\mathbf{A}.}
\]

The potentials are not unique. The transformation

\[
\boxed{
\mathbf{A}'=\mathbf{A}+\nabla\chi,
\qquad
\phi'=\phi-\frac{\partial\chi}{\partial t}}
\]

leaves \(\mathbf{E}\) and \(\mathbf{B}\) unchanged. This freedom is
called gauge freedom.

One especially useful choice is the Lorenz gauge,

\[
\nabla\cdot\mathbf{A}
+\frac{1}{c^2}\frac{\partial\phi}{\partial t}=0.
\]

In vacuum, the potentials then obey wave equations driven by their sources:

\[
\boxed{
\begin{aligned}
\nabla^2\phi-\frac{1}{c^2}\frac{\partial^2\phi}{\partial t^2}
&=-\frac{\rho}{\varepsilon_0},\\
\nabla^2\mathbf{A}-\frac{1}{c^2}
\frac{\partial^2\mathbf{A}}{\partial t^2}
&=-\mu_0\mathbf{J}.
\end{aligned}}
\]

Changes in sources therefore influence distant fields at the finite speed
\(c\), rather than instantaneously.

## 11. Electromagnetic waves in vacuum

### 11.1 Deriving the wave equation

In source-free vacuum,

\[
\rho=0,
\qquad
\mathbf{J}=\mathbf{0}.
\]

Take the curl of Faraday's law:

\[
\nabla\times(\nabla\times\mathbf{E})
=-\frac{\partial}{\partial t}(\nabla\times\mathbf{B}).
\]

Use the vector identity

\[
\nabla\times(\nabla\times\mathbf{E})
=\nabla(\nabla\cdot\mathbf{E})-\nabla^2\mathbf{E}
\]

together with \(\nabla\cdot\mathbf{E}=0\) and
\(\nabla\times\mathbf{B}=\mu_0\varepsilon_0\partial\mathbf{E}/\partial t\).
The result is

\[
\boxed{
\nabla^2\mathbf{E}
-\mu_0\varepsilon_0\frac{\partial^2\mathbf{E}}{\partial t^2}=0.}
\]

The same procedure gives

\[
\boxed{
\nabla^2\mathbf{B}
-\mu_0\varepsilon_0\frac{\partial^2\mathbf{B}}{\partial t^2}=0.}
\]

These are wave equations with speed

\[
\boxed{c=\frac{1}{\sqrt{\mu_0\varepsilon_0}}.}
\]

The numerical value is the measured speed of light. This was Maxwell's decisive
insight: light is an electromagnetic wave.

### 11.2 Plane-wave solutions

A monochromatic plane wave can be written as

\[
\mathbf{E}(\mathbf{r},t)
=\mathbf{E}_0\cos(\mathbf{k}\cdot\mathbf{r}-\omega t+\delta).
\]

Substitution into the wave equation gives the vacuum dispersion relation

\[
\boxed{\omega=c|\mathbf{k}|.}
\]

Gauss's laws require

\[
\mathbf{k}\cdot\mathbf{E}_0=0,
\qquad
\mathbf{k}\cdot\mathbf{B}_0=0.
\]

Faraday's law relates the two amplitudes:

\[
\boxed{
\mathbf{B}_0=\frac{1}{\omega}\mathbf{k}\times\mathbf{E}_0,
\qquad
B_0=\frac{E_0}{c}.}
\]

Thus \(\mathbf{E}\), \(\mathbf{B}\), and the propagation direction are
mutually perpendicular. The wave is transverse.

For a wave traveling in the positive \(z\)-direction with electric field
along \(x\),

\[
\begin{aligned}
\mathbf{E}(z,t)&=E_0\cos(kz-\omega t)\hat{\mathbf{x}},\\
\mathbf{B}(z,t)&=\frac{E_0}{c}\cos(kz-\omega t)\hat{\mathbf{y}}.
\end{aligned}
\]

### 11.3 Polarization

Polarization describes the path traced by the electric-field vector at a fixed
point in space.

- Linear polarization: the field oscillates along a fixed line.
- Circular polarization: two equal perpendicular components differ in phase by
  one quarter-cycle.
- Elliptical polarization: the most general monochromatic case.

Polarization is central to antennas, optical filters, remote sensing, and
communication systems.

## 12. Electromagnetic energy and the Poynting theorem

### 12.1 Energy density and energy flux

The electromagnetic energy density in vacuum is

\[
\boxed{
u=\frac{\varepsilon_0}{2}E^2+\frac{1}{2\mu_0}B^2.}
\]

The Poynting vector is

\[
\boxed{
\mathbf{S}=\frac{1}{\mu_0}\mathbf{E}\times\mathbf{B}.}
\]

Its direction gives the direction of energy transport, and its magnitude has
units of power per unit area.

### 12.2 Derivation of local energy conservation

Take the dot product of \(\mathbf{E}\) with the Ampere--Maxwell law and the
dot product of \(\mathbf{B}/\mu_0\) with Faraday's law. Using

\[
\nabla\cdot(\mathbf{E}\times\mathbf{B})
=\mathbf{B}\cdot(\nabla\times\mathbf{E})
-\mathbf{E}\cdot(\nabla\times\mathbf{B}),
\]

one obtains

\[
\boxed{
\frac{\partial u}{\partial t}
+\nabla\cdot\mathbf{S}
=-\mathbf{J}\cdot\mathbf{E}.}
\]

This is Poynting's theorem. The terms mean:

- \(\partial u/\partial t\): rate of change of field energy density;
- \(\nabla\cdot\mathbf{S}\): net electromagnetic energy flowing outward;
- \(\mathbf{J}\cdot\mathbf{E}\): power delivered by the field to matter.

In integral form,

\[
\boxed{
\frac{d}{dt}\iiint_Vu\,dV
+\oiint_{\partial V}\mathbf{S}\cdot d\mathbf{a}
=-\iiint_V\mathbf{J}\cdot\mathbf{E}\,dV.}
\]

### 12.3 Intensity of a sinusoidal plane wave

For a vacuum plane wave, the electric and magnetic energy densities are equal:

\[
\frac{\varepsilon_0}{2}E^2
=\frac{1}{2\mu_0}B^2.
\]

The instantaneous Poynting magnitude is

\[
S=c\varepsilon_0E^2.
\]

For \(E=E_0\cos(kz-\omega t)\), the time-averaged intensity is

\[
\boxed{
\langle S\rangle
=\frac{1}{2}c\varepsilon_0E_0^2
=\frac{E_{\mathrm{rms}}^2}{\mu_0c}.}
\]

Electromagnetic waves also carry momentum. In vacuum, the momentum density is

\[
\mathbf{g}=\frac{\mathbf{S}}{c^2}.
\]

The average radiation pressure on a perfectly absorbing surface is
\(\langle S\rangle/c\), and on a perfectly reflecting surface at normal
incidence it is \(2\langle S\rangle/c\).

## 13. Important limiting cases

Maxwell's equations contain several familiar theories as approximations.

### 13.1 Electrostatics

When all fields and sources are time-independent,

\[
\nabla\times\mathbf{E}=0,
\qquad
\mathbf{E}=-\nabla\phi.
\]

Gauss's law becomes Poisson's equation:

\[
\boxed{\nabla^2\phi=-\frac{\rho}{\varepsilon_0}.}
\]

In a charge-free region,

\[
\boxed{\nabla^2\phi=0,}
\]

which is Laplace's equation.

### 13.2 Magnetostatics

For steady currents and time-independent fields,

\[
\nabla\times\mathbf{B}=\mu_0\mathbf{J},
\qquad
\nabla\cdot\mathbf{B}=0.
\]

The Biot--Savart law follows:

\[
\boxed{
\mathbf{B}(\mathbf{r})
=\frac{\mu_0}{4\pi}
\iiint
\frac{\mathbf{J}(\mathbf{r}')\times(\mathbf{r}-\mathbf{r}')}
{|\mathbf{r}-\mathbf{r}'|^3}\,dV'.}
\]

### 13.3 Quasistatic circuit theory

Ordinary lumped-element circuit laws are approximations valid when the circuit
size is much smaller than the electromagnetic wavelength and propagation delays
can be neglected. Kirchhoff's voltage law is modified when appreciable changing
magnetic flux threads a circuit, while Kirchhoff's current law is the integral
expression of charge conservation.

## 14. A practical problem-solving strategy

When solving an electromagnetic problem, use the following sequence.

### Step 1: identify the regime

Ask whether the problem is electrostatic, magnetostatic, quasistatic, or fully
time-dependent. Decide whether vacuum equations or macroscopic material
equations are appropriate.

### Step 2: identify sources and symmetry

Locate \(\rho\), \(\mathbf{J}\), free surface charge, and surface current.
Look for spherical, cylindrical, planar, translational, or rotational symmetry.

### Step 3: choose differential or integral form

Use integral laws when symmetry makes the field constant along a surface or
loop. Use differential equations and boundary conditions when the geometry is
more complicated.

### Step 4: choose coordinates and directions first

Before calculating magnitudes, determine the possible field direction from
symmetry. A correct vector direction often reduces the problem to one unknown
scalar function.

### Step 5: apply boundary and initial conditions

Differential equations have many mathematical solutions. Boundary and initial
conditions select the physical one.

### Step 6: check the result

Verify units, limiting cases, continuity conditions, symmetry, and energy
behavior. A field that violates another Maxwell equation cannot be correct.

## 15. Common misconceptions

### Misconception 1: zero divergence means zero field

False. A uniform magnetic field has zero divergence but is not zero. Divergence
measures local sources, not field magnitude.

### Misconception 2: Gauss's law can always determine the electric field

Gauss's law is always valid, but it directly determines \(\mathbf{E}\) only
when enough symmetry is present.

### Misconception 3: magnetic fields are produced only by electric current

Conduction current produces magnetic fields, but a changing electric field does
too. The displacement-current term is essential for capacitors, radiation, and
charge conservation.

### Misconception 4: induced electric fields exist only inside magnetic fields

Faraday's law relates circulation to changing enclosed flux. An induced electric
field may exist in a region where the local magnetic field is small or zero.

### Misconception 5: electromagnetic waves require a material medium

They do not. Time-varying electric and magnetic fields sustain one another in
vacuum and propagate at \(c\).

### Misconception 6: potentials are merely mathematical conveniences

Potentials contain gauge freedom, but they organize electromagnetic dynamics,
make causality transparent, and play a fundamental role in modern physics.

## 16. Conceptual synthesis

The four equations can be remembered as a connected physical story:

1. Electric charge is a source of electric flux.
2. No isolated magnetic charge has been observed, so magnetic flux has no
   beginning or end.
3. A changing magnetic field creates a circulating electric field.
4. Electric current and a changing electric field create a circulating magnetic
   field.

The last two laws form a self-sustaining cycle:

\[
\text{changing }\mathbf{E}
\longrightarrow
\text{changing }\mathbf{B}
\longrightarrow
\text{changing }\mathbf{E}.
\]

That cycle propagates through space as an electromagnetic wave. The constants
\(\varepsilon_0\) and \(\mu_0\), first encountered in electrostatic and
magnetic experiments, determine the speed of that wave. Electricity,
magnetism, and light are therefore different manifestations of one field.

## 17. Summary sheet

### Vacuum equations

\[
\boxed{
\begin{aligned}
\nabla\cdot\mathbf{E}&=\rho/\varepsilon_0,
&\oiint\mathbf{E}\cdot d\mathbf{a}&=Q_{\mathrm{enc}}/\varepsilon_0,\\
\nabla\cdot\mathbf{B}&=0,
&\oiint\mathbf{B}\cdot d\mathbf{a}&=0,\\
\nabla\times\mathbf{E}&=-\partial\mathbf{B}/\partial t,
&\oint\mathbf{E}\cdot d\boldsymbol{\ell}&=-d\Phi_B/dt,\\
\nabla\times\mathbf{B}&=\mu_0\mathbf{J}
+\mu_0\varepsilon_0\partial\mathbf{E}/\partial t,
&\oint\mathbf{B}\cdot d\boldsymbol{\ell}
&=\mu_0I_{\mathrm{enc}}+\mu_0\varepsilon_0d\Phi_E/dt.
\end{aligned}}
\]

### Essential consequences

\[
\boxed{
\begin{aligned}
\nabla\cdot\mathbf{J}+\frac{\partial\rho}{\partial t}&=0,
&&\text{charge conservation},\\
c&=\frac{1}{\sqrt{\mu_0\varepsilon_0}},
&&\text{wave speed in vacuum},\\
u&=\frac{\varepsilon_0E^2}{2}+\frac{B^2}{2\mu_0},
&&\text{field energy density},\\
\mathbf{S}&=\frac{1}{\mu_0}\mathbf{E}\times\mathbf{B},
&&\text{energy flux}.
\end{aligned}}
\]

## 18. Exercises

### Exercise 1: infinite line charge

An infinite line has uniform charge per unit length \(\lambda\). Use a
cylindrical Gaussian surface to find the electric field at distance \(r\).

### Exercise 2: infinite current sheet

An infinite sheet carries uniform surface current
\(\mathbf{K}=K\hat{\mathbf{x}}\). Use the Ampere--Maxwell law and symmetry to
find the magnetic field on each side.

### Exercise 3: changing magnetic flux

A circular loop of radius \(a\) lies in a uniform perpendicular field
\(B(t)=B_0e^{-t/\tau}\). Find the induced emf and state its direction.

### Exercise 4: capacitor displacement current

A parallel-plate capacitor of circular plate radius \(R\) is charged by a
constant current \(I\). Neglect fringing. Find the magnetic field between the
plates at radius \(r<R\).

### Exercise 5: plane-wave amplitude

A sinusoidal plane wave in vacuum has electric-field amplitude
\(E_0=120\ \mathrm{V\,m^{-1}}\). Find its magnetic-field amplitude and average
intensity.

### Exercise 6: charge conservation

The charge density is \(\rho(\mathbf{r},t)=\rho_0e^{-t/\tau}f(\mathbf{r})\).
Write the condition that the associated current density must satisfy.

### Exercise 7: boundary conditions

Two linear dielectrics meet at a charge-free interface. Explain which components
of \(\mathbf{E}\) and \(\mathbf{D}\) are continuous and which may change.

## 19. Short answers to the exercises

### Answer 1

For a cylinder of length \(L\),

\[
E(2\pi rL)=\frac{\lambda L}{\varepsilon_0},
\qquad
\boxed{\mathbf{E}=\frac{\lambda}{2\pi\varepsilon_0r}\hat{\mathbf{r}}.}
\]

### Answer 2

The field is parallel to the sheet and perpendicular to the current. With the
sheet in the \(xy\)-plane,

\[
\boxed{
\mathbf{B}_{z>0}=-\frac{\mu_0K}{2}\hat{\mathbf{y}},
\qquad
\mathbf{B}_{z<0}=\frac{\mu_0K}{2}\hat{\mathbf{y}}.}
\]

### Answer 3

\[
\boxed{
\mathcal{E}=-\pi a^2\frac{dB}{dt}
=\frac{\pi a^2B_0}{\tau}e^{-t/\tau}.}
\]

The induced current produces a magnetic field in the same direction as the
decaying original field.

### Answer 4

The enclosed displacement current is \(Ir^2/R^2\), so

\[
\boxed{B(r)=\frac{\mu_0Ir}{2\pi R^2},\qquad r<R.}
\]

### Answer 5

\[
\begin{aligned}
B_0&=\frac{E_0}{c}\approx4.00\times10^{-7}\ \mathrm{T},\\
\langle S\rangle
&=\frac{1}{2}c\varepsilon_0E_0^2
\approx19.1\ \mathrm{W\,m^{-2}}.
\end{aligned}
\]

### Answer 6

\[
\boxed{
\nabla\cdot\mathbf{J}
=-\frac{\partial\rho}{\partial t}
=\frac{\rho_0}{\tau}e^{-t/\tau}f(\mathbf{r}).}
\]

### Answer 7

With no free surface charge, normal \(\mathbf{D}\) is continuous. Tangential
\(\mathbf{E}\) is also continuous. Because
\(\mathbf{D}=\varepsilon\mathbf{E}\), normal \(\mathbf{E}\) and tangential
\(\mathbf{D}\) generally change when the permittivity changes.

---

Maxwell's equations are not four isolated rules to memorize. They are a tightly
connected system expressing source structure, induction, conservation, wave
propagation, and energy transport. Learning to move between their local and
integral forms is the key to using them as a practical theory rather than merely
recognizing them as famous formulas.
