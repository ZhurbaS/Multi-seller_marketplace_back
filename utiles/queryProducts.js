class queryProducts {
  products = [];
  query = {};
  constructor(products, query) {
    this.products = products;
    this.query = query;
  }

  categoryQuery = (categoryId) => {
    this.products = this.query?.category
      ? this.products.filter((p) => p.category.toString() === categoryId)
      : this.products;
    return this;
  };

  searchQuery = () => {
    this.products = this.query?.searchValue
      ? this.products.filter(
          (p) =>
            p.name.toUpperCase().indexOf(this.query.searchValue.toUpperCase()) >
            -1
        )
      : this.products;
    return this;
  };

  ratingQuery = () => {
    this.products = this.query?.rating
      ? this.products.filter(
          (p) =>
            parseInt(this.query.rating) <= p.rating &&
            p.rating < parseInt(this.query.rating) + 1
        )
      : this.products;
    return this;
  };

  priceQuery = () => {
    this.products = this.products.filter(
      (p) => p.price >= this.query.lowPrice && p.price <= this.query.highPrice
    );
    return this;
  };

  sortByPrice = () => {
    const { sortPrice } = this.query;
    if (sortPrice)
      this.products = this.products.sort((a, b) =>
        sortPrice === "low-to-high" ? a.price - b.price : b.price - a.price
      );
    return this;
  };

  skip = () => {
    let { pageNumber } = this.query;
    const skipPage = (parseInt(pageNumber) - 1) * this.query.perPage;
    let skipProduct = [];
    for (let i = skipPage; i < this.products.length; i++) {
      skipProduct.push(this.products[i]);
    }
    this.products = skipProduct;
    return this;
  };

  limit = () => {
    let temp = [];
    if (this.products.length > this.query.perPage) {
      for (let i = 0; i < this.query.perPage; i++) {
        temp.push(this.products[i]);
      }
    } else {
      temp = this.products;
    }
    this.products = temp;
    return this;
  };

  getProducts = () => {
    return this.products;
  };

  countProducts = () => {
    return this.products.length;
  };
}

module.exports = queryProducts;
