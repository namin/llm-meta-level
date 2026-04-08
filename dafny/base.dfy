// Base module: methods with specifications.
// The LLM can replace implementations but must preserve the specs.

method Abs(x: int) returns (r: int)
  ensures r >= 0
  ensures r == x || r == -x
{
  if x < 0 { r := -x; } else { r := x; }
}

method Max(a: int, b: int) returns (r: int)
  ensures r >= a && r >= b
  ensures r == a || r == b
{
  if a >= b { r := a; } else { r := b; }
}

method Min(a: int, b: int) returns (r: int)
  ensures r <= a && r <= b
  ensures r == a || r == b
{
  if a <= b { r := a; } else { r := b; }
}

method Clamp(x: int, lo: int, hi: int) returns (r: int)
  requires lo <= hi
  ensures lo <= r <= hi
  ensures lo <= x <= hi ==> r == x
  ensures x < lo ==> r == lo
  ensures x > hi ==> r == hi
{
  if x < lo { r := lo; }
  else if x > hi { r := hi; }
  else { r := x; }
}

function Fib(n: nat): nat
  decreases n
{
  if n == 0 then 0
  else if n == 1 then 1
  else Fib(n - 1) + Fib(n - 2)
}

method ComputeFib(n: nat) returns (r: nat)
  ensures r == Fib(n)
{
  if n == 0 { return 0; }
  var a, b := 0, 1;
  var i := 1;
  while i < n
    invariant 1 <= i <= n
    invariant a == Fib(i - 1)
    invariant b == Fib(i)
  {
    a, b := b, a + b;
    i := i + 1;
  }
  return b;
}
