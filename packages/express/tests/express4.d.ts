// The Express 4 dev alias ("express4": "npm:express@4") has no own types.
declare module "express4" {
  import express from "express";
  export default express;
}
